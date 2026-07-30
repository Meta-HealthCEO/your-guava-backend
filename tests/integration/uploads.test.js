const mockR2Files = new Map();
let mockR2DeleteError = null;
jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async (buffer, key) => { mockR2Files.set(key, buffer); },
  downloadFile: async (key) => mockR2Files.get(key),
  getSignedDownloadUrl: async (key) => `https://test.r2.local/${key}`,
  deleteFile: async (key) => {
    if (mockR2DeleteError) throw mockR2DeleteError;
    mockR2Files.delete(key);
  },
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
const Upload = require('../../src/models/Upload.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockR2DeleteError = null;
  mockR2Files.clear();
  await clearDB();
});

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

    it('stages and confirms semicolon CSVs with normalised headers', async () => {
      const csv = Buffer.from([
        '\uFEFF Sale Date ; Sale Time ; Description ; Amount ',
        '2026-04-01;09:30;Flat White;R 35,00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'semicolon.csv');

      expect(stage.status).toBe(200);
      expect(stage.body.headers).toEqual(['Sale Date', 'Sale Time', 'Description', 'Amount']);

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            date: 'Sale Date',
            time: 'Sale Time',
            items: 'Description',
            total: 'Amount',
          },
          itemsMode: 'packed',
        });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats.imported).toBe(1);

      const tx = await Transaction.findOne({ uploadId: stage.body.uploadId }).lean();
      expect(tx.total).toBe(35);
      expect(tx.hour).toBe(9);
    });

    it('persists row-level errors for partially valid uploads', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        'R500,2026-04-01,08:30,1 x Flat White,35.00',
        'R501,not-a-date,08:45,1 x Muffin,25.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'partial-errors.csv');

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            receiptId: 'Receipt',
            date: 'Date',
            time: 'Time',
            items: 'Items',
            total: 'Total',
          },
          itemsMode: 'packed',
        });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats).toMatchObject({ imported: 1, errors: 1, totalRows: 2 });
      expect(confirm.body.rowErrors).toEqual([
        expect.objectContaining({
          rowNumber: 3,
          reason: 'Could not parse date or time',
          raw: expect.objectContaining({ Receipt: 'R501', Date: 'not-a-date' }),
        }),
      ]);

      const detail = await request
        .get(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(detail.body.upload.rowErrors).toHaveLength(1);
      expect(detail.body.upload.rowErrors[0]).toMatchObject({
        rowNumber: 3,
        reason: 'Could not parse date or time',
      });
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

    it('returns 400 when line-per-row mapping has no receipt ID', async () => {
      const csv = Buffer.from([
        'Date,Time,Item,Qty,Line Total',
        '2026-04-01,08:30,Flat White,1,35.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'line-without-receipt.csv');

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            date: 'Date',
            time: 'Time',
            items: 'Item',
            quantity: 'Qty',
            total: 'Line Total',
          },
          itemsMode: 'line-per-row',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/receiptId/i);
    });

    it('returns 400 when a mapped column is not present in the staged file', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            ...stage.body.columnMapping,
            total: 'Definitely Not A Column',
          },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/not in this file/i);
    });

    it('returns 400 when the file has headers but no transaction rows', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('Date,Items,Total\n'), 'empty.csv');

      expect(stage.status).toBe(200);

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: { date: 'Date', items: 'Items', total: 'Total' },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no transaction rows/i);
    });

    it('returns 400 when no approved transaction rows are present', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Status,Items,Total',
        'D1,2026-04-01,08:30,declined,1 x Flat White,35.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'declined-only.csv');

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            receiptId: 'Receipt',
            date: 'Date',
            time: 'Time',
            status: 'Status',
            items: 'Items',
            total: 'Total',
          },
          itemsMode: 'packed',
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no approved transaction rows/i);

      const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(txns).toHaveLength(0);
    });

    it('does not mark duplicate-only uploads as successful imports', async () => {
      const firstStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const firstConfirm = await request
        .post(`/api/uploads/${firstStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: firstStage.body.columnMapping, itemsMode: firstStage.body.itemsMode });
      expect(firstConfirm.status).toBe(200);

      const secondStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const secondConfirm = await request
        .post(`/api/uploads/${secondStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: secondStage.body.columnMapping, itemsMode: secondStage.body.itemsMode });

      expect(secondConfirm.status).toBe(409);
      expect(secondConfirm.body.message).toMatch(/already exists/i);

      const secondTxns = await Transaction.find({ uploadId: secondStage.body.uploadId }).lean();
      expect(secondTxns).toHaveLength(0);

      const upload = await Upload.findById(secondStage.body.uploadId).lean();
      expect(upload.status).toBe('failed');
      expect(upload.errorMessage).toMatch(/already exists/i);
      expect(await Transaction.countDocuments({})).toBe(4);
    });

    it('does not allow a deleted upload to be confirmed', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);

      await Upload.updateOne({ _id: stage.body.uploadId }, { $set: { status: 'deleted' } });

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(404);
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

    it('rolls back the replacement when persistence fails after transactional deletion', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const Item = require('../../src/models/Item.model');
      const itemsBefore = await Item.find({}).sort({ _id: 1 }).lean();
      const ingestionService = require('../../src/services/ingestion.service');
      const persistSpy = jest.spyOn(ingestionService, 'persistParsedRows')
        .mockRejectedValueOnce(new Error('injected persistence failure'));

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: { ...stage.body.columnMapping, items: 'Payment Method' },
          itemsMode: stage.body.itemsMode,
        });
      persistSpy.mockRestore();

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
      const upload = await Upload.findById(stage.body.uploadId).lean();
      expect(upload.status).toBe('completed');
      expect(upload.stats.imported).toBe(4);
      expect(await Item.find({}).sort({ _id: 1 }).lean()).toEqual(itemsBefore);
    });

    it('preserves transactions when re-map parses no valid rows', async () => {
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

      const res = await request
        .patch(`/api/uploads/${stage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            ...stage.body.columnMapping,
            date: 'Payment Method',
          },
          itemsMode: stage.body.itemsMode,
        });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/no valid transaction rows/i);

      const afterTxns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(4);
    });

    it('preserves transactions when re-map would duplicate another upload', async () => {
      const csv = Buffer.from([
        'Receipt,Date,Time,Items,Total',
        'R900,2026-04-01,08:30,1 x Flat White,35.00',
      ].join('\n'));
      const mappingWithoutReceipt = {
        date: 'Date',
        time: 'Time',
        items: 'Items',
        total: 'Total',
      };
      const mappingWithReceipt = {
        receiptId: 'Receipt',
        ...mappingWithoutReceipt,
      };

      const firstStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'receiptless.csv');
      await request
        .post(`/api/uploads/${firstStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithoutReceipt, itemsMode: 'packed' });

      const secondStage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'receipted.csv');
      await request
        .post(`/api/uploads/${secondStage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithReceipt, itemsMode: 'packed' });

      const beforeTxns = await Transaction.find({ uploadId: firstStage.body.uploadId }).lean();
      expect(beforeTxns).toHaveLength(1);

      const res = await request
        .patch(`/api/uploads/${firstStage.body.uploadId}/mapping`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: mappingWithReceipt, itemsMode: 'packed' });

      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/leave this upload empty/i);

      const afterTxns = await Transaction.find({ uploadId: firstStage.body.uploadId }).lean();
      expect(afterTxns).toHaveLength(1);

      const Upload = require('../../src/models/Upload.model');
      const upload = await Upload.findById(firstStage.body.uploadId).lean();
      expect(upload.status).toBe('completed');
      expect(upload.columnMapping.receiptId).toBeUndefined();
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

    it('recovers a stale parsing lease and allows retry', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await Upload.collection.updateOne(
        { _id: new (require('mongoose').Types.ObjectId)(stage.body.uploadId) },
        {
          $set: {
            status: 'parsing',
            updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
          },
        }
      );

      const res = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      expect(res.status).toBe(200);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
    });
  });

  describe('abandoned pending upload cleanup', () => {
    it('removes storage and soft-deletes expired unconfirmed uploads', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      const staged = await Upload.findById(stage.body.uploadId).lean();
      await Upload.collection.updateOne(
        { _id: staged._id },
        { $set: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }
      );

      const { cleanupAbandonedPendingUploads } = require('../../src/controllers/uploads.controller');
      const summary = await cleanupAbandonedPendingUploads({ olderThanMs: 60 * 60 * 1000 });

      expect(summary).toMatchObject({ scanned: 1, deleted: 1, failed: 0 });
      expect(mockR2Files.has(staged.r2Key)).toBe(false);
      expect((await Upload.findById(staged._id).lean()).status).toBe('deleted');
    });
  });

  describe('DELETE /api/uploads/:id', () => {
    it('owner soft-deletes upload, removing transactions and R2 object', async () => {
      const Item = require('../../src/models/Item.model');
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const brownieBefore = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieBefore.totalSold).toBe(4);

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const txns = await Transaction.find({ uploadId: stage.body.uploadId }).lean();
      expect(txns).toHaveLength(0);

      const Upload = require('../../src/models/Upload.model');
      const u = await Upload.findById(stage.body.uploadId).lean();
      expect(u.status).toBe('deleted');

      const brownieAfter = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieAfter.totalSold).toBe(0);
    });

    it('rolls back transaction deletion when the item rebuild fails', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const staged = await Upload.findById(stage.body.uploadId).lean();
      const Item = require('../../src/models/Item.model');
      const brownieBefore = await Item.findOne({ name: 'Brownie' }).lean();
      expect(brownieBefore.totalSold).toBe(4);
      const ingestionService = require('../../src/services/ingestion.service');
      const rebuildItemsForCafe = ingestionService.rebuildItemsForCafe;
      const rebuildSpy = jest.spyOn(ingestionService, 'rebuildItemsForCafe')
        .mockImplementationOnce(async (...args) => {
          await rebuildItemsForCafe(...args);
          throw new Error('injected item rebuild failure');
        });

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);
      rebuildSpy.mockRestore();

      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await Transaction.countDocuments({ uploadId: stage.body.uploadId })).toBe(4);
      expect((await Upload.findById(stage.body.uploadId).lean()).status).toBe('completed');
      expect(mockR2Files.has(staged.r2Key)).toBe(true);
      expect((await Item.findOne({ name: 'Brownie' }).lean()).totalSold).toBe(4);
    });

    it('marks failed storage deletion for bounded background retry', async () => {
      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
      const staged = await Upload.findById(stage.body.uploadId).lean();
      mockR2DeleteError = new Error('temporary storage outage');

      const res = await request
        .delete(`/api/uploads/${stage.body.uploadId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const pendingCleanup = await Upload.findById(stage.body.uploadId).lean();
      expect(pendingCleanup.status).toBe('deleted');
      expect(pendingCleanup.errorMessage).toMatch(/background cleanup/i);
      expect(mockR2Files.has(staged.r2Key)).toBe(true);

      mockR2DeleteError = null;
      const { cleanupAbandonedPendingUploads } = require('../../src/controllers/uploads.controller');
      const summary = await cleanupAbandonedPendingUploads({ limit: 10 });

      expect(summary.storageRetried).toBe(1);
      expect(mockR2Files.has(staged.r2Key)).toBe(false);
      expect((await Upload.findById(stage.body.uploadId).lean()).errorMessage).toBeUndefined();
    });
  });

  describe('Upload triggers actuals back-fill', () => {
    it('after confirm, calls updateForecastActuals for each day in the upload range', async () => {
      const Forecast = require('../../src/models/Forecast.model');

      const stage = await request.post('/api/transactions/upload').set('Authorization', `Bearer ${token}`).attach('file', yocoFixture);
      await request.post(`/api/uploads/${stage.body.uploadId}/confirm`).set('Authorization', `Bearer ${token}`).send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      // generateWeekForecast should have created 7 forecasts for today + 6 future days
      const after = await Forecast.countDocuments({});
      expect(after).toBeGreaterThanOrEqual(7);
    });
  });

  describe('Forecast invalidation', () => {
    it('preserves historical forecasts and refreshes planning forecasts on successful confirm', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      // Get cafeId from the registered user
      const u = await createTestUser({ email: 'd@yourguava.com', cafeName: 'Cafe D', orgName: 'Org D' });
      const cafeId = u.user?.cafeIds?.[0];
      if (!cafeId) return; // skip if shape doesn't expose cafeId

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(0, 0, 0, 0);
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);

      // Historical forecasts are needed for predicted-vs-actual review.
      await Forecast.create({
        cafeId,
        date: yesterday,
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
        totalPredictedRevenue: 123,
      });

      await Forecast.create({
        cafeId,
        date: tomorrow,
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
        totalPredictedRevenue: 999999,
      });

      const stale = await Forecast.find({ cafeId }).lean();
      expect(stale.length).toBe(2);

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${u.token}`)
        .attach('file', yocoFixture);
      await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${u.token}`)
        .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

      const after = await Forecast.find({ cafeId }).lean();
      expect(after.some((forecast) => forecast.date.getTime() === yesterday.getTime())).toBe(true);
      expect(after.some((forecast) => forecast.totalPredictedRevenue === 999999)).toBe(false);
      expect(after.length).toBeGreaterThanOrEqual(7);
    });
  });
});
