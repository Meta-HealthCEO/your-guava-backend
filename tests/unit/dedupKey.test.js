const { computeDedupKey } = require('../../src/utils/dedupKey');

describe('computeDedupKey', () => {
  it('produces a deterministic SHA1 hex string for identical inputs', () => {
    const a = computeDedupKey({ date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] });
    const b = computeDedupKey({ date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{40}$/);
  });

  it('produces different keys when any field differs', () => {
    const base = { date: '2026-04-01', time: '08:30', total: 45.5, items: [{ name: 'Flat White', quantity: 1 }] };
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, total: 46 }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, time: '08:31' }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, date: '2026-04-02' }));
    expect(computeDedupKey(base)).not.toBe(computeDedupKey({ ...base, items: [{ name: 'Cappuccino', quantity: 1 }] }));
  });

  it('treats missing time as empty string consistently', () => {
    const a = computeDedupKey({ date: '2026-04-01', total: 45.5, items: [] });
    const b = computeDedupKey({ date: '2026-04-01', time: '', total: 45.5, items: [] });
    expect(a).toBe(b);
  });

  it('orders items deterministically regardless of input order', () => {
    const items1 = [{ name: 'A', quantity: 1 }, { name: 'B', quantity: 2 }];
    const items2 = [{ name: 'B', quantity: 2 }, { name: 'A', quantity: 1 }];
    const a = computeDedupKey({ date: '2026-04-01', total: 50, items: items1 });
    const b = computeDedupKey({ date: '2026-04-01', total: 50, items: items2 });
    expect(a).toBe(b);
  });
});
