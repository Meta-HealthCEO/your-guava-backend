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

describe('Transactions API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
  });

  describe('POST /api/transactions/upload', () => {
    it('uploads Yoco CSV and returns preset mapping ready to confirm', async () => {
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.posType).toBe('yoco');
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.needsConfirmation).toBe(false);
      expect(res.body.columnMapping.date).toBe('Date');
    });

    it('returns 400 when no file is uploaded', async () => {
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });
  });

  // re-enabled after /uploads/:id/confirm exists (Task 11)
  describe('GET /api/transactions', () => {
    it('returns paginated list of transactions', async () => {
      // Upload some data first
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

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

  // re-enabled after /uploads/:id/confirm exists (Task 11)
  describe('GET /api/transactions/stats', () => {
    it('returns correct stats after upload', async () => {
      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

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
