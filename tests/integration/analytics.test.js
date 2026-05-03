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

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Analytics API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
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
  });
});
