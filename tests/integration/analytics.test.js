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
    await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', csvPath);
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
    });

    it('returns empty arrays when no data', async () => {
      const res = await request
        .get('/api/analytics/items')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.items).toEqual([]);
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
      // 7 days * 18 hours (5-22) = 126 entries
      expect(res.body.heatmap.length).toBe(126);
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
});
