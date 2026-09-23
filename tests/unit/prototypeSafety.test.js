jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));

const { buildSummaryStats } = require('../../src/services/anthropic.service');

const sale = (items) => ({ date: new Date('2026-04-01T08:00:00Z'), total: 10, items });

describe('name-keyed accumulators', () => {
  it('counts items named like prototype keys as ordinary items', () => {
    const summary = buildSummaryStats([
      sale([{ name: 'constructor', quantity: 1 }]),
      sale([{ name: '__proto__', quantity: 2 }, { name: 'Latte', quantity: 3 }]),
      sale([{ name: 'constructor', quantity: 4 }]),
    ], 'Africa/Johannesburg');
    expect(summary.topItems).toEqual([
      { name: 'constructor', qty: 5 },
      { name: 'Latte', qty: 3 },
      { name: '__proto__', qty: 2 },
    ]);
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect(Object.keys(Object)).toEqual([]);
  });
});
