/**
 * Live smoke test of the core product loop against a running backend:
 *   register → upload POS CSV → confirm mapping → week forecast → history.
 *
 * Usage: node scripts/smoke-pipeline.js [apiBaseUrl]
 * Exits non-zero on the first failed expectation.
 */
const API = (process.argv[2] || 'http://localhost:5000/api').replace(/\/$/, '');

const PRICES = { 'Flat White': 40, Cappuccino: 38, Croissant: 35 };
const flatWhiteQtyFor = (dayOfWeek) => 5 + dayOfWeek;
const pad = (n) => String(n).padStart(2, '0');
const yocoDate = (d) => `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;

const buildHistoryCsv = (days = 56) => {
  const header =
    'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount';
  const rows = [header];
  let receipt = 1;
  for (let daysAgo = days; daysAgo >= 1; daysAgo--) {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - daysAgo);
    for (const [item, qty] of [
      ['Flat White', flatWhiteQtyFor(date.getDay())],
      ['Cappuccino', 4],
      ['Croissant', 3],
    ]) {
      const total = (qty * PRICES[item]).toFixed(2);
      rows.push(
        `S-${String(receipt++).padStart(6, '0')},${yocoDate(date)},09:30:00,Approved,Credit Card,#${receipt},,${qty} x ${item},,ZAR,0.0,0.0,0.0,${total},0.0,${total}`
      );
    }
  }
  return rows.join('\n');
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

(async () => {
  console.log(`Smoke-testing ${API}\n`);

  // 1. Register a fresh account
  const email = `smoke-${Date.now()}@yourguava.test`;
  const registerRes = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email,
      password: 'smoke-test-password-1',
      name: 'Smoke Tester',
      cafeName: 'Smoke Cafe',
    }),
  });
  const register = await registerRes.json();
  check('register account', registerRes.status === 201 && Boolean(register.accessToken));
  const auth = { Authorization: `Bearer ${register.accessToken}` };

  // 2. Upload a POS export (Yoco format, 56 days of history)
  const csv = buildHistoryCsv(56);
  const form = new FormData();
  form.append('file', new Blob([csv], { type: 'text/csv' }), 'smoke-yoco-export.csv');
  const stageRes = await fetch(`${API}/transactions/upload`, {
    method: 'POST',
    headers: auth,
    body: form,
  });
  const stage = await stageRes.json();
  check('stage upload', stageRes.status === 200 && Boolean(stage.uploadId));
  check('Yoco format auto-detected', stage.needsConfirmation === false);

  // 3. Confirm — triggers parsing, ingestion, forecast generation
  const confirmRes = await fetch(`${API}/uploads/${stage.uploadId}/confirm`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ columnMapping: stage.columnMapping, itemsMode: stage.itemsMode }),
  });
  const confirm = await confirmRes.json();
  check('confirm + ingest', confirmRes.status === 200, `imported ${confirm.stats?.imported}`);
  check('all rows imported', confirm.stats?.imported === 56 * 3);

  // 4. Week forecast with per-item predictions
  const weekRes = await fetch(`${API}/forecasts/week`, { headers: auth });
  const week = await weekRes.json();
  check('week forecast returns 7 days', week.forecasts?.length === 7);

  const allDaysHaveItems = (week.forecasts || []).every(
    (f) => f.items?.length > 0 && f.items.every((i) => i.predictedQty > 0)
  );
  check('every day has positive per-item predictions', allDaysHaveItems);

  const tomorrow = week.forecasts?.[1];
  const flatWhite = tomorrow?.items?.find((i) => i.itemName === 'Flat White');
  const expected = flatWhiteQtyFor(new Date(tomorrow?.date).getDay());
  check(
    'prediction tracks weekday pattern',
    flatWhite && Math.abs(flatWhite.predictedQty - expected) <= Math.ceil(expected * 0.6),
    `Flat White predicted ${flatWhite?.predictedQty}, weekday baseline ${expected}`
  );

  // 5. History with predicted-vs-actual accuracy
  const historyRes = await fetch(
    `${API}/forecasts/history?days=3&backfill=sync&backfillLimit=3`,
    { headers: auth }
  );
  const history = await historyRes.json();
  const rows = history.rows || [];
  check('history rows generated', rows.length > 0, `${rows.length} rows`);
  check(
    'accuracy computed on history',
    rows.every((r) => r.revenueAccuracy != null && r.revenueAccuracy > 50),
    `overall ${history.meta?.overallRevenueAccuracy}%`
  );

  // 6. Dashboard stats endpoint
  const statsRes = await fetch(`${API}/transactions/stats`, { headers: auth });
  const stats = await statsRes.json();
  check('transaction stats served', stats.stats?.totalTransactions === 56 * 3);

  console.log(`\n${failures === 0 ? 'SMOKE PASSED' : `SMOKE FAILED (${failures} checks)`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('Smoke run crashed:', err.message);
  process.exit(1);
});
