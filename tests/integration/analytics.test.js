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

const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Transaction = require('../../src/models/Transaction.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Analytics API', () => {
  let token;
  let cafeId;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    cafeId = testUser.user.activeCafeId;
  });

  const uploadTestData = async () => {
    const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csvPath);
    await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
  };

  describe('GET /api/analytics/revenue', () => {
    it('returns revenue data with transactions', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/revenue')
        .set('Authorization', `Bearer ${token}`)
        .query({
          startDate: '2026-01-01',
          endDate: '2026-01-31',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.summary).toBeDefined();
      expect(res.body.summary.totalRevenue).toBeGreaterThan(0);
      expect(res.body.meta).toBeDefined();
      expect(res.body.meta.period).toBe('daily');
    });

    it('returns empty data with no transactions', async () => {
      const res = await request
        .get('/api/analytics/revenue')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([]);
    });

    it('treats date-only ranges as full local cafe days', async () => {
      await Transaction.create({
        cafeId,
        date: new Date('2026-01-15T00:30:00+02:00'),
        hour: 0,
        dayOfWeek: 4,
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 }],
        total: 40,
      });

      const res = await request
        .get('/api/analytics/revenue')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-15', endDate: '2026-01-15' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        { date: '2026-01-15', revenue: 40, transactions: 1 },
      ]);
      expect(res.body.summary.totalRevenue).toBe(40);
    });
  });

  describe('GET /api/analytics/items', () => {
    it('returns item performance data', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/items')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.items).toBeDefined();
      expect(Array.isArray(res.body.items)).toBe(true);
      expect(res.body.meta).toBeDefined();
      expect(Array.isArray(res.body.meta.risingItems)).toBe(true);
      expect(Array.isArray(res.body.meta.decliningItems)).toBe(true);
    });

    it('returns empty arrays when no data', async () => {
      const res = await request
        .get('/api/analytics/items')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
    });

    it('accepts date range params', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/items')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-01', endDate: '2026-01-31' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.meta.startDate).toBe('2026-01-01');
      expect(res.body.meta.endDate).toBe('2026-01-31');
    });

    it('calculates item trends from the selected data window, not wall-clock today', async () => {
      const docs = [];
      for (let day = 1; day <= 7; day++) {
        docs.push({
          cafeId,
          date: new Date(`2026-01-${String(day).padStart(2, '0')}T09:00:00+02:00`),
          hour: 9,
          dayOfWeek: day % 7,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 }],
          total: 40,
        });
      }
      for (let day = 8; day <= 14; day++) {
        docs.push({
          cafeId,
          date: new Date(`2026-01-${String(day).padStart(2, '0')}T09:00:00+02:00`),
          hour: 9,
          dayOfWeek: day % 7,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 2, unitPrice: 40 }],
          total: 80,
        });
      }
      await Transaction.insertMany(docs);

      const res = await request
        .get('/api/analytics/items')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-01', endDate: '2026-01-14' });

      expect(res.status).toBe(200);
      expect(res.body.items[0]).toEqual(
        expect.objectContaining({
          name: 'Flat White',
          totalQty: 21,
          avgPerDay: 1.5,
          trend: 100,
        })
      );
      expect(res.body.meta.risingItems).toContainEqual({ name: 'Flat White', trend: 100 });
    });
  });

  describe('GET /api/analytics/heatmap', () => {
    it('returns heatmap grid', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/heatmap')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.heatmap).toBeDefined();
      expect(Array.isArray(res.body.heatmap)).toBe(true);
      // 7 days * 17 hours (6-22) = 119 entries
      expect(res.body.heatmap.length).toBe(119);
    });

    it('accepts date range params', async () => {
      const res = await request
        .get('/api/analytics/heatmap')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-01', endDate: '2026-01-31' });

      expect(res.status).toBe(200);
      expect(res.body.meta.startDate).toBe('2026-01-01');
    });

    it('returns average revenue per observed weekday/hour, not period totals', async () => {
      await Transaction.insertMany([
        {
          cafeId,
          date: new Date('2026-01-05T09:00:00+02:00'),
          hour: 9,
          dayOfWeek: 1,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 1, unitPrice: 100 }],
          total: 100,
        },
        {
          cafeId,
          date: new Date('2026-01-12T09:00:00+02:00'),
          hour: 9,
          dayOfWeek: 1,
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 1, unitPrice: 300 }],
          total: 300,
        },
        {
          cafeId,
          date: new Date('2026-01-12T10:00:00+02:00'),
          hour: 10,
          dayOfWeek: 1,
          status: 'approved',
          items: [{ name: 'Brownie', quantity: 1, unitPrice: 50 }],
          total: 50,
        },
      ]);

      const res = await request
        .get('/api/analytics/heatmap')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-05', endDate: '2026-01-12' });

      expect(res.status).toBe(200);
      expect(res.body.meta.metric).toBe('average_per_observed_weekday');

      const monday9 = res.body.heatmap.find((cell) => cell.dayOfWeek === 1 && cell.hour === 9);
      const monday10 = res.body.heatmap.find((cell) => cell.dayOfWeek === 1 && cell.hour === 10);

      expect(monday9).toEqual(
        expect.objectContaining({
          revenue: 200,
          transactions: 1,
          totalRevenue: 400,
          totalTransactions: 2,
          observedDays: 2,
        })
      );
      expect(monday10).toEqual(
        expect.objectContaining({
          revenue: 25,
          transactions: 0.5,
          totalRevenue: 50,
          totalTransactions: 1,
          observedDays: 2,
        })
      );
    });
  });

  describe('GET /api/analytics/customers', () => {
    it('returns customer insights with data', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/customers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.insights).toBeDefined();
      expect(res.body.insights.avgTransactionValue).toBeGreaterThan(0);
    });

    it('returns zero insights when no data', async () => {
      const res = await request
        .get('/api/analytics/customers')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.insights.avgTransactionValue).toBe(0);
    });
  });

  describe('GET /api/analytics/combos', () => {
    it('returns top item pairs', async () => {
      await uploadTestData();

      const res = await request
        .get('/api/analytics/combos')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta).toBeDefined();
    });

    it('returns empty array when no data', async () => {
      const res = await request
        .get('/api/analytics/combos')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('deduplicates repeated item names before generating pairs', async () => {
      await Transaction.create({
        cafeId,
        date: new Date('2026-01-20T09:00:00+02:00'),
        hour: 9,
        dayOfWeek: 2,
        status: 'approved',
        items: [
          { name: 'Flat White', quantity: 1, unitPrice: 40 },
          { name: 'Flat White', quantity: 1, unitPrice: 40 },
          { name: 'Brownie', quantity: 1, unitPrice: 35 },
        ],
        total: 115,
      });

      const res = await request
        .get('/api/analytics/combos')
        .set('Authorization', `Bearer ${token}`)
        .query({ startDate: '2026-01-20', endDate: '2026-01-20' });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([{ pair: ['Brownie', 'Flat White'], count: 1 }]);
    });
  });
});
