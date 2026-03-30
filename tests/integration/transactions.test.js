const path = require('path');
const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Transactions API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
  });

  describe('POST /api/transactions/upload', () => {
    it('uploads CSV file and imports approved transactions', async () => {
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.imported).toBe(4); // 4 approved
      expect(res.body.skipped).toBe(1); // 1 declined
      expect(res.body.errors).toBe(0);
    });

    it('skips duplicates on re-upload', async () => {
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

      // First upload
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      // Second upload — all should be skipped
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      expect(res.status).toBe(200);
      expect(res.body.imported).toBe(0);
      expect(res.body.skipped).toBe(5); // 4 duplicates + 1 declined
    });

    it('returns 400 when no file is uploaded', async () => {
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/no file/i);
    });
  });

  describe('GET /api/transactions', () => {
    it('returns paginated list of transactions', async () => {
      // Upload some data first
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      const res = await request
        .get('/api/transactions')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transactions).toBeDefined();
      expect(Array.isArray(res.body.transactions)).toBe(true);
      expect(res.body.transactions.length).toBe(4);
      expect(res.body.pagination).toBeDefined();
      expect(res.body.pagination.total).toBe(4);
    });

    it('returns empty list when no transactions exist', async () => {
      const res = await request
        .get('/api/transactions')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toEqual([]);
      expect(res.body.pagination.total).toBe(0);
    });
  });

  describe('GET /api/transactions/stats', () => {
    it('returns correct stats after upload', async () => {
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      const res = await request
        .get('/api/transactions/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.stats).toBeDefined();
      expect(res.body.stats.totalTransactions).toBe(4);
      expect(res.body.stats.totalRevenue).toBeGreaterThan(0);
      expect(res.body.stats.topItems).toBeDefined();
      expect(Array.isArray(res.body.stats.topItems)).toBe(true);
    });

    it('returns zero stats when no transactions exist', async () => {
      const res = await request
        .get('/api/transactions/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.stats.totalTransactions).toBe(0);
      expect(res.body.stats.totalRevenue).toBe(0);
    });
  });
});
