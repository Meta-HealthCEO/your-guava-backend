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
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Item = require('../../src/models/Item.model');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const uploadGenericCsv = async (token, csv) => {
  const stage = await request
    .post('/api/transactions/upload')
    .set('Authorization', `Bearer ${token}`)
    .attach('file', Buffer.from(csv), 'menu-items-test.csv');

  const mapping = {
    receiptId: 'Receipt',
    date: 'Date',
    time: 'Time',
    items: 'Items',
    total: 'Total',
  };
  const confirm = await request
    .post(`/api/uploads/${stage.body.uploadId}/confirm`)
    .set('Authorization', `Bearer ${token}`)
    .send({ columnMapping: mapping, itemsMode: 'packed' });

  expect(confirm.status).toBe(200);
  return confirm;
};

describe('Menu items API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  it('creates review items from imported sales names', async () => {
    await uploadGenericCsv(
      token,
      'Receipt,Date,Time,Items,Total\nR1,2026-04-01,08:30,1 x Flat White,35.00'
    );

    const res = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.meta.needsReview).toBe(1);
    expect(res.body.items[0]).toMatchObject({
      name: 'Flat White',
      reviewStatus: 'needs_review',
      category: 'coffee',
      aiSuggestion: expect.objectContaining({
        action: 'confirm',
        source: 'rules',
        needsApproval: true,
      }),
    });
  });

  it('maps an imported unknown item to an existing menu item', async () => {
    const canonical = await request
      .post('/api/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Cappuccino', category: 'coffee', expectedPrice: 38 });
    expect(canonical.status).toBe(201);

    await uploadGenericCsv(
      token,
      'Receipt,Date,Time,Items,Total\nR2,2026-04-01,08:30,1 x Capuccino,38.00'
    );

    const review = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${token}`);
    expect(review.body.items[0].aiSuggestion).toEqual(
      expect.objectContaining({
        action: 'map_to',
        targetItemId: canonical.body.item._id,
      })
    );

    const source = await Item.findOne({ cafeId: user.activeCafeId, name: 'Capuccino' }).lean();
    const res = await request
      .post(`/api/items/${source._id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'map_to', targetItemId: canonical.body.item._id });

    expect(res.status).toBe(200);
    expect(res.body.item.aliases).toContain('Capuccino');

    const tx = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
    expect(tx.items[0]).toMatchObject({
      name: 'Cappuccino',
      rawName: 'Capuccino',
      menuItemStatus: 'matched',
    });
  });

  it('flags matched items when observed price is outside tolerance', async () => {
    const created = await request
      .post('/api/items')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Flat White', category: 'coffee', expectedPrice: 35, priceTolerancePct: 10 });
    expect(created.status).toBe(201);

    await uploadGenericCsv(
      token,
      'Receipt,Date,Time,Items,Total\nR3,2026-04-01,08:30,1 x Flat White,50.00'
    );

    const tx = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
    expect(tx.items[0].menuItemStatus).toBe('price_mismatch');
    expect(tx.items[0].priceVariancePct).toBeCloseTo(42.86, 2);

    const res = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.meta.priceMismatches).toBe(1);
    expect(res.body.items[0].name).toBe('Flat White');
    expect(res.body.items[0].aiSuggestion).toEqual(
      expect.objectContaining({
        action: 'confirm',
        expectedPrice: 50,
      })
    );

    const resolved = await request
      .post(`/api/items/${res.body.items[0]._id}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send({ action: 'confirm', expectedPrice: 50 });
    expect(resolved.status).toBe(200);

    const refreshed = await Item.findById(res.body.items[0]._id).lean();
    expect(refreshed.priceMismatchCount).toBe(0);
    expect(refreshed.lastPriceMismatchAt).toBeNull();

    const updatedTx = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
    expect(updatedTx.items[0]).toMatchObject({
      menuItemStatus: 'matched',
      expectedPrice: 50,
    });
    expect(updatedTx.items[0].priceVariancePct).toBeUndefined();

    const afterResolve = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${token}`);
    expect(afterResolve.body.meta.priceMismatches).toBe(0);
  });
});
