const mongoose = require('mongoose');
const { setup, teardown, clearDB } = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');
const { syncOrders } = require('../../src/services/yoco.service');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('yoco.service', () => {
  it('does not inflate item totals when duplicate orders are synced', async () => {
    const cafeId = new mongoose.Types.ObjectId();
    const order = {
      id: 'order-1',
      created_at: '2026-04-01T08:30:00Z',
      line_items: [
        {
          item_type: 'product',
          name: 'Flat White',
          quantity: 2,
          unit_price: { amount: 3500 },
        },
      ],
      amounts: {
        gross_amount: { amount: 7000 },
      },
      payments: [{ payment_method: 'card' }],
    };

    const first = await syncOrders(cafeId, [order]);
    const second = await syncOrders(cafeId, [order]);

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await Transaction.countDocuments({ cafeId })).toBe(1);

    const item = await Item.findOne({ cafeId, name: 'Flat White' }).lean();
    expect(item.totalSold).toBe(2);
    expect(item.avgPrice).toBe(35);
    expect(item.category).toBe('coffee');
  });
});
