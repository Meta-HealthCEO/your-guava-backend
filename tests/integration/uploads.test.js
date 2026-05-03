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

const yocoFixture = path.join(__dirname, '..', 'fixtures', 'test-transactions.csv');

describe('Uploads API', () => {
  let token;

  beforeEach(async () => {
    const u = await createTestUser();
    token = u.token;
  });

  describe('POST /api/uploads/:id/confirm', () => {
    it('parses transactions and marks upload completed', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;

      const confirm = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(confirm.status).toBe(200);
      expect(confirm.body.success).toBe(true);
      expect(confirm.body.stats.imported).toBe(4);

      const txns = await Transaction.find({ uploadId }).lean();
      expect(txns).toHaveLength(4);
      expect(txns[0].uploadId.toString()).toBe(uploadId);
    });

    it('returns 409 when confirming an already-completed upload', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const uploadId = stage.body.uploadId;
      await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const second = await request
        .post(`/api/uploads/${uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(second.status).toBe(409);
    });

    it('returns 400 when required fields are missing from mapping', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: { date: 'Date' }, itemsMode: 'packed' });
      expect(res.status).toBe(400);
    });
  });
});
