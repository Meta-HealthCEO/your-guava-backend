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

  it('does not flag a price mismatch from a multi-item receipt', async () => {
    // A packed multi-item receipt only carries the basket total, so each line
    // gets a basket average (100 / 3 = 33.33) rather than a price. Before the
    // parser flagged those as derived, 21 of 22 items in a real cafe showed a
    // false "price differs" warning on the Menu Items page.
    for (const body of [
      { name: 'Flat White', category: 'coffee', expectedPrice: 38, priceTolerancePct: 10 },
      { name: 'Coca Cola 330ml', category: 'cold_drink', expectedPrice: 24, priceTolerancePct: 10 },
    ]) {
      const created = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(created.status).toBe(201);
    }

    await uploadGenericCsv(
      token,
      'Receipt,Date,Time,Items,Total\nR4,2026-04-01,08:30,"2 x Flat White,1 x Coca Cola 330ml",100.00'
    );

    const tx = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
    expect(tx.items.map((item) => item.priceSource)).toEqual(['derived', 'derived']);
    expect(tx.items.map((item) => item.menuItemStatus)).toEqual(['matched', 'matched']);
    expect(tx.items.every((item) => item.priceVariancePct === undefined)).toBe(true);

    const res = await request
      .get('/api/items/reconciliation')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.meta.priceMismatches).toBe(0);
  });

  // The match key used to delete every parenthesised group, and parenthesised
  // modifiers are how a Yoco till writes a variant. "Cappuccino (Small)" and
  // "Cappuccino (Large)" therefore resolved to one Item with one expectedPrice,
  // the large sale was rewritten to disk as a small, and the owner could not
  // even add the missing variant by hand -- create answered 409.
  describe('menu variants', () => {
    const importBothSizes = () =>
      uploadGenericCsv(
        token,
        [
          'Receipt,Date,Time,Items,Total',
          'R1,2026-04-01,08:30,1 x Cappuccino (Small),28.00',
          'R2,2026-04-01,08:31,1 x Cappuccino (Large),38.00',
        ].join('\n')
      );

    it('keeps parenthesised size variants as separate menu items', async () => {
      await importBothSizes();

      const items = await Item.find({ cafeId: user.activeCafeId }).sort({ name: 1 }).lean();
      expect(items.map((item) => item.name)).toEqual(['Cappuccino (Large)', 'Cappuccino (Small)']);
      expect(items.map((item) => item.expectedPrice)).toEqual([38, 28]);
      expect(items.map((item) => item.totalSold)).toEqual([1, 1]);
    });

    it('records each variant sale against the variant that was sold', async () => {
      await importBothSizes();

      const transactions = await Transaction.find({ cafeId: user.activeCafeId })
        .sort({ receiptId: 1 })
        .lean();
      expect(transactions.map((tx) => tx.items[0].name)).toEqual([
        'Cappuccino (Small)',
        'Cappuccino (Large)',
      ]);
      // Two prices for one item used to raise a permanent, unfixable warning.
      expect(transactions.map((tx) => tx.items[0].menuItemStatus)).toEqual([
        'needs_review',
        'needs_review',
      ]);
    });

    it('lets the owner add a variant of an item that already exists', async () => {
      const small = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Cappuccino (Small)', category: 'coffee', expectedPrice: 28 });
      expect(small.status).toBe(201);

      const large = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Cappuccino (Large)', category: 'coffee', expectedPrice: 38 });
      expect(large.status).toBe(201);

      // Punctuation and case are still levelled, so a genuine re-entry collides.
      const duplicate = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'cappuccino  (large)' });
      expect(duplicate.status).toBe(409);
    });

    it('does not offer to merge one variant into its sibling', async () => {
      const small = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Cappuccino (Small)', category: 'coffee', expectedPrice: 28 });
      expect(small.status).toBe(201);

      await uploadGenericCsv(
        token,
        'Receipt,Date,Time,Items,Total\nR9,2026-04-01,08:31,1 x Cappuccino (Large),38.00'
      );

      const res = await request
        .get('/api/items/reconciliation')
        .set('Authorization', `Bearer ${token}`);
      const large = res.body.items.find((item) => item.name === 'Cappuccino (Large)');
      expect(large).toBeDefined();
      expect(large.candidates.map((candidate) => candidate.item.name)).not.toContain('Cappuccino (Small)');
      expect(large.aiSuggestion.action).toBe('confirm');
    });

    it('answers 409 rather than 500 when a legacy row already holds the name', async () => {
      // Items written before normalizedName existed carry no key, so the
      // pre-check misses them and the unique {cafeId, name} index raised a 500.
      await Item.create({ cafeId: user.activeCafeId, name: 'Flat White', category: 'coffee' });

      const res = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Flat White' });
      expect(res.status).toBe(409);
    });
  });

  describe('rebuild versus the owner', () => {
    it('keeps an edit the sales history disagrees with', async () => {
      const canonical = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Cappuccino', category: 'coffee', expectedPrice: 38 });
      expect(canonical.status).toBe(201);

      await uploadGenericCsv(
        token,
        'Receipt,Date,Time,Items,Total\nR2,2026-04-01,08:30,1 x Capuccino,38.00'
      );
      const source = await Item.findOne({ cafeId: user.activeCafeId, name: 'Capuccino' }).lean();
      await request
        .post(`/api/items/${source._id}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'map_to', targetItemId: canonical.body.item._id });

      // Every one of these is a value the rebuild relearns from sales, and it
      // used to relearn them before the PUT's own response was written.
      const edited = await request
        .put(`/api/items/${canonical.body.item._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ aliases: [], expectedPrice: 0, category: 'other' });
      expect(edited.status).toBe(200);

      const stored = await Item.findById(canonical.body.item._id).lean();
      expect(stored.aliases).toEqual([]);
      expect(stored.aliasKeys).toEqual([]);
      expect(stored.expectedPrice).toBe(0);
      expect(stored.category).toBe('other');
    });

    it('does not move another menu item\'s sales when an alias collides with its name', async () => {
      await uploadGenericCsv(
        token,
        'Receipt,Date,Time,Items,Total\nR1,2026-04-01,08:30,1 x Cappuccino,38.00'
      );
      const cappuccino = await Item.findOne({ cafeId: user.activeCafeId, name: 'Cappuccino' }).lean();

      const shorthand = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Cap', aliases: ['Cappuccino'] });
      expect(shorthand.status).toBe(201);

      await request
        .put(`/api/items/${shorthand.body.item._id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ notes: 'shorthand for the till' });

      const tx = await Transaction.findOne({ cafeId: user.activeCafeId }).lean();
      expect(String(tx.items[0].salesItemId)).toBe(String(cappuccino._id));
      expect(tx.items[0].name).toBe('Cappuccino');
      expect((await Item.findById(cappuccino._id).lean()).totalSold).toBe(1);
    });

    it('keeps the merged name as an alias even when the target list is full', async () => {
      const target = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Cappuccino',
          aliases: Array.from({ length: 50 }, (_, index) => `Legacy Name ${index}`),
        });
      expect(target.status).toBe(201);

      await uploadGenericCsv(
        token,
        'Receipt,Date,Time,Items,Total\nR1,2026-04-01,08:30,1 x Capuccino,38.00'
      );
      const source = await Item.findOne({ cafeId: user.activeCafeId, name: 'Capuccino' }).lean();
      const res = await request
        .post(`/api/items/${source._id}/resolve`)
        .set('Authorization', `Bearer ${token}`)
        .send({ action: 'map_to', targetItemId: target.body.item._id });
      expect(res.status).toBe(200);

      // Without the merged name in aliasKeys the same misspelling comes back as
      // a fresh review item after every single upload, with no explanation.
      const stored = await Item.findById(target.body.item._id).lean();
      expect(stored.aliases).toContain('Capuccino');
      expect(stored.aliasKeys).toContain('capuccino');
    });
  });

  describe('price statistics', () => {
    it('learns the most recent exact price when a day shares one timestamp', async () => {
      // Date-only exports put a whole day's sales at midnight, so insertion
      // order is the only tiebreak the rebuild has.
      await uploadGenericCsv(
        token,
        [
          'Receipt,Date,Time,Items,Total',
          'R1,2026-04-01,08:30,1 x Flat White,35.00',
          'R2,2026-04-01,08:30,1 x Flat White,42.00',
        ].join('\n')
      );

      const item = await Item.findOne({ cafeId: user.activeCafeId, name: 'Flat White' }).lean();
      expect(item.lastObservedPrice).toBe(42);
    });

    it('shows a price range the till actually charged', async () => {
      // A packed multi-item receipt only carries the basket total, so its lines
      // get a 100/3 average. Showing that as the bottom of the price range on
      // the very screen built for verifying prices undermines the whole queue.
      await uploadGenericCsv(
        token,
        [
          'Receipt,Date,Time,Items,Total',
          'R1,2026-04-01,08:30,"2 x Flat White,1 x Coca Cola 330ml",100.00',
          'R2,2026-04-02,08:30,1 x Flat White,38.00',
        ].join('\n')
      );

      const item = await Item.findOne({ cafeId: user.activeCafeId, name: 'Flat White' }).lean();
      expect(item.observedPriceMin).toBe(38);
      expect(item.observedPriceMax).toBe(38);
    });
  });

  it('reports the true review backlog rather than the size of the page', async () => {
    const lines = ['Receipt,Date,Time,Items,Total'];
    for (let index = 0; index < 6; index += 1) {
      lines.push(`R${index},2026-04-0${index + 1},08:30,1 x Mystery Item ${index},20.00`);
    }
    await uploadGenericCsv(token, lines.join('\n'));

    const res = await request
      .get('/api/items/reconciliation?limit=2')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    // The owner has to be able to tell 2-of-6 from 2-of-2, or they cannot know
    // whether working the queue is making any progress.
    expect(res.body.meta.needsReview).toBe(6);
    expect(res.body.meta.returned).toBe(2);
  });

  it('rejects oversized or invalid menu-item mutations', async () => {
    const invalidPayloads = [
      { name: 'x'.repeat(201) },
      { name: 'Flat White', expectedPrice: -1 },
      { name: 'Flat White', expectedPrice: 1000001 },
      { name: 'Flat White', priceTolerancePct: 101 },
      { name: 'Flat White', aliases: Array.from({ length: 51 }, (_, index) => `Alias ${index}`) },
      { name: 'Flat White', notes: 'x'.repeat(2001) },
      { name: 'Flat White', category: 'not-a-category' },
      { name: 'Flat White', isActive: 'false' },
    ];

    for (const payload of invalidPayloads) {
      const response = await request
        .post('/api/items')
        .set('Authorization', `Bearer ${token}`)
        .send(payload);
      expect(response.status).toBe(400);
    }
    expect(await Item.countDocuments({ cafeId: user.activeCafeId })).toBe(0);
  });
});
