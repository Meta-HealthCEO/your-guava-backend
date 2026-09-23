const mockR2Files = new Map();
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => { mockR2Files.delete(key); },
  _resetClient: () => {},
}));
jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app, assertPrototypesClean } = require('../setup');

const request = supertest(app);
const MAPPING = { receiptId: 'Receipt', date: 'Date', time: 'Time', items: 'Items', total: 'Total' };
// The trend compares the latest seven days of data (4-10 Apr) with the seven
// before (28 Mar-3 Apr), so every reserved name has a value in at least one.
const CSV = [
  'Receipt,Date,Time,Items,Total',
  'R1,2026-04-01,08:30,"1 x __proto__,1 x Latte",60.00',
  'R2,2026-04-02,09:00,2 x constructor,40.00',
  'R3,2026-04-03,10:00,"1 x prototype,1 x Latte",55.00',
  'R4,2026-04-09,08:30,3 x __proto__,90.00',
  'R5,2026-04-10,09:15,1 x constructor,20.00',
].join(String.fromCharCode(10));

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2Files.clear();
  await clearDB();
});

it('imports reserved item names and every item reader answers without touching a prototype', async () => {
  const { token } = await createTestUser();
  const auth = { Authorization: `Bearer ${token}` };
  const stage = await request.post('/api/transactions/upload').set(auth).attach('file', Buffer.from(CSV), 'reserved-names.csv');
  const confirm = await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set(auth).send({ columnMapping: MAPPING, itemsMode: 'packed' });
  expect(confirm.status).toBe(200);
  expect(confirm.body.stats.imported).toBe(5);
  assertPrototypesClean();

  const readers = [
    '/api/analytics/items',
    '/api/analytics/items?startDate=2026-04-01&endDate=2026-04-10',
    '/api/analytics/combos?startDate=2026-04-01&endDate=2026-04-10',
    '/api/analytics/revenue?startDate=2026-04-01&endDate=2026-04-10',
    '/api/transactions/stats',
    '/api/items',
    '/api/items/reconciliation',
  ];
  for (const url of readers) {
    const response = await request.get(url).set(auth);
    expect({ url, status: response.status }).toEqual({ url, status: 200 });
    assertPrototypesClean();
  }

  // The default window is relative to today; the fixture's sales are in April 2026, so read them inside their own window.
  const items = (await request.get('/api/analytics/items?startDate=2026-04-01&endDate=2026-04-10').set(auth)).body.items;
  const trendOf = (name) => items.find((item) => item.name === name)?.trend;
  expect(items.map((item) => item.name)).toEqual(expect.arrayContaining(['__proto__', 'constructor', 'prototype', 'Latte']));
  expect(trendOf('__proto__')).toBe(200); // 3 this week against 1 the week before
  expect(trendOf('constructor')).toBe(-50); // 1 against 2
  expect(trendOf('prototype')).toBe(-100); // 0 against 1

  const generated = await request.post('/api/forecasts/generate').set(auth).send({ date: '2026-04-11' });
  expect(generated.status).toBeLessThan(500);
  assertPrototypesClean();
});
