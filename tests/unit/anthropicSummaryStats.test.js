const { buildSummaryStats } = require('../../src/services/anthropic.service');

describe('buildSummaryStats', () => {
  it('counts an item named constructor or __proto__ like any other item', () => {
    // Item names come straight from POS files. On a plain object, "constructor"
    // read back Object and turned its count into the string
    // "function Object() { [native code] }3" in what the model was told, and
    // "__proto__" was silently dropped.
    const transactions = [
      {
        date: new Date('2026-01-05T09:00:00+02:00'),
        total: 60,
        items: [
          { name: 'constructor', quantity: 3 },
          { name: '__proto__', quantity: 2 },
          { name: 'Latte', quantity: 1 },
        ],
      },
    ];

    const { topItems } = buildSummaryStats(transactions);

    expect(topItems).toEqual([
      { name: 'constructor', qty: 3 },
      { name: '__proto__', qty: 2 },
      { name: 'Latte', qty: 1 },
    ]);
  });
});
