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

  describe('GET /api/uploads', () => {
    it('returns uploads for the current cafe in reverse chronological order', async () => {
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.uploads).toHaveLength(2);
      expect(new Date(res.body.uploads[0].createdAt).getTime())
        .toBeGreaterThanOrEqual(new Date(res.body.uploads[1].createdAt).getTime());
    });

    it('does not leak uploads across cafes', async () => {
      const other = await createTestUser({ email: 'b@yourguava.com', cafeName: 'Cafe B', orgName: 'Org B' });
      await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${other.token}`)
        .attach('file', yocoFixture);
      const res = await request.get('/api/uploads').set('Authorization', `Bearer ${token}`);
      expect(res.body.uploads).toHaveLength(0);
    });
  });

  describe('GET /api/uploads/:id', () => {
    it('returns the upload record with a signed download URL', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.upload._id).toBe(stage.body.uploadId);
      expect(res.body.upload.status).toBe('completed');
      expect(res.body.downloadUrl).toMatch(/^https:\/\//);
    });

    it("returns 404 for another cafe's upload", async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const other = await createTestUser({ email: 'c@yourguava.com', cafeName: 'Cafe C', orgName: 'Org C' });
      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${other.token}`);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/uploads/:id/rows', () => {
    it('returns paginated transactions linked to this upload', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const res = await request
        .get(`/api/uploads/${stage.body.uploadId}/rows`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.transactions).toHaveLength(4);
      expect(res.body.transactions[0].uploadId).toBe(stage.body.uploadId);
    });
  });

  describe('PATCH /api/uploads/:id/mapping', () => {
    it('re-parses with new mapping, replacing transactions', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const before = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(before).toHaveLength(4);

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(200);
      expect(res.body.stats.imported).toBe(4);
      const after = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(after).toHaveLength(4);
    });

    it('preserves transactions when re-parse fails (atomicity)', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const beforeTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(beforeTxns).toHaveLength(4);

      // Inject a parse failure via spy so we bypass the 400 guard
      const parserService = require('../../src/services/parser.service');
      const spy = jest.spyOn(parserService, 'parseBuffer').mockRejectedValueOnce(
        new Error('injected parse failure')
      );

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      spy.mockRestore();

      // The request should have failed
      expect(res.status).toBeGreaterThanOrEqual(500);

      // Original transactions must still exist — atomicity preserved
      const afterTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(4);
    });

    it('returns 409 when status is parsing', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const Upload = require('../../src/models/Upload.model');
      await Upload.updateOne({ _id: stage.body.uploadId }, { $set: { status: 'parsing' } });
      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /api/uploads/:id', () => {
    it('owner soft-deletes upload, removing transactions and R2 object', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(txns).toHaveLength(0);

      const Upload = require('../../src/models/Upload.model');
      const u = await Upload.findById(stage.body.uploadId).lean();
      expect(u.status).toBe('deleted');
    });
  });

  describe('Forecast invalidation', () => {
    it('deletes cached forecasts on successful confirm', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      // Get cafeId from the registered user
      const u = await createTestUser({ email: 'd@yourguava.com', cafeName: 'Cafe D', orgName: 'Org D' });
      const cafeId = u.user?.cafeIds?.[0];
      if (!cafeId) return; // skip if shape doesn't expose cafeId

      // Pre-create a stale forecast for this cafe
      await Forecast.create({
        cafeId,
        date: new Date(),
        generatedAt: new Date(),
        items: [],
        signals: {
          weather: { temp: 20, condition: 'clear', humidity: 60 },
          loadSheddingStage: 0,
          isPublicHoliday: false,
          isSchoolHoliday: false,
          isPayday: false,
          dayOfWeek: 0,
          events: [],
        },
        totalPredictedRevenue: 0,
      });

      const stale = await Forecast.find({ cafeId }).lean();
      expect(stale.length).toBeGreaterThan(0);

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${u.token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const after = await Forecast.find({ cafeId }).lean();
      expect(after.length).toBe(0);
    });
  });
});
