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
const Cafe = require('../../src/models/Cafe.model');

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Transactions API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
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

    it('returns 400 for unsupported file extensions', async () => {
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', Buffer.from('not,a,pos,file'), 'data.txt');

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/csv/i);
    });

    it('takes an Excel "sep=;" export from upload through confirm', async () => {
      // The first customer's file. The import learned to skip the directive in
      // b1d532c, but the upload preview still read "sep=" as the header row,
      // so the wizard had nothing to map and the file never reached confirm.
      const semicolonExport = Buffer.from([
        'sep=;',
        'Receipt;Date;Time;Status;Items;Total (incl. tax)',
        '1001;2026/09/14;09:00:00;Approved;1 x Flat White;38.00',
      ].join('\n'));

      const stage = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', semicolonExport, 'till-export.csv');

      expect(stage.status).toBe(200);
      expect(stage.body.headers).toEqual(['Receipt', 'Date', 'Time', 'Status', 'Items', 'Total (incl. tax)']);

      const confirm = await request
        .post(`/api/uploads/${stage.body.uploadId}/confirm`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          columnMapping: {
            receiptId: 'Receipt', date: 'Date', time: 'Time', status: 'Status', items: 'Items', total: 'Total (incl. tax)',
          },
          itemsMode: 'packed',
        });

      expect(confirm.status).toBe(200);
      expect(confirm.body.stats.imported).toBe(1);
    });

    it('refuses a tiny workbook that declares a million rows, before reading it', async () => {
      // 2.6 KB on disk with <dimension ref="A1:XFD1048576"/>: read-excel-file
      // allocates what a sheet declares before any row limit applies, so this
      // asked for about 17 billion slots and took the API down for every cafe.
      const bomb = path.join(__dirname, '..', 'fixtures', 'xlsx-declares-A1-XFD1048576.xlsx');
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', bomb);

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/1048576 rows by 16384 columns/);
    });

    it('does not auto-confirm a stale saved mapping against a different header shape', async () => {
      await Cafe.findByIdAndUpdate(user.activeCafeId, {
        $set: {
          savedColumnMapping: {
            date: 'Old Date',
            items: 'Old Items',
            total: 'Old Total',
            itemsMode: 'packed',
          },
        },
      });

      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-generic-pos.csv');
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      expect(res.status).toBe(200);
      expect(res.body.posType).toBe('wizard');
      expect(res.body.needsConfirmation).toBe(true);
      expect(res.body.columnMapping).toEqual({});
    });

    it('auto-confirms a saved mapping only when it matches the current headers', async () => {
      await Cafe.findByIdAndUpdate(user.activeCafeId, {
        $set: {
          savedColumnMapping: {
            receiptId: 'Txn Number',
            date: 'Sale Date',
            time: 'Sale Time',
            items: 'Description',
            total: 'Amount',
            itemsMode: 'packed',
          },
        },
      });

      const csvPath = path.join(__dirname, '..', 'fixtures', 'test-generic-pos.csv');
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csvPath);

      expect(res.status).toBe(200);
      expect(res.body.posType).toBe('wizard');
      expect(res.body.needsConfirmation).toBe(false);
      expect(res.body.columnMapping.date).toBe('Sale Date');
    });

    it('does not auto-confirm a line-per-row saved mapping without receipt ID', async () => {
      await Cafe.findByIdAndUpdate(user.activeCafeId, {
        $set: {
          savedColumnMapping: {
            date: 'Date',
            time: 'Time',
            items: 'Item',
            quantity: 'Qty',
            total: 'Line Total',
            itemsMode: 'line-per-row',
          },
        },
      });

      const csv = Buffer.from([
        'Date,Time,Item,Qty,Line Total',
        '2026-04-01,08:30,Flat White,1,35.00',
      ].join('\n'));
      const res = await request
        .post('/api/transactions/upload')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', csv, 'line-no-receipt.csv');

      expect(res.status).toBe(200);
      expect(res.body.posType).toBe('wizard');
      expect(res.body.itemsMode).toBe('line-per-row');
      expect(res.body.needsConfirmation).toBe(true);
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

    it('calculates average daily revenue over the inclusive date range', async () => {
      const Transaction = require('../../src/models/Transaction.model');
      const firstDate = new Date('2026-05-20T09:00:00.000Z');
      const secondDate = new Date('2026-05-21T09:00:00.000Z');

      await Transaction.create([
        {
          cafeId: user.activeCafeId,
          date: firstDate,
          hour: 9,
          dayOfWeek: firstDate.getDay(),
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 1, unitPrice: 40 }],
          total: 100,
        },
        {
          cafeId: user.activeCafeId,
          date: secondDate,
          hour: 9,
          dayOfWeek: secondDate.getDay(),
          status: 'approved',
          items: [{ name: 'Long White', quantity: 1, unitPrice: 40 }],
          total: 200,
        },
      ]);

      const res = await request
        .get('/api/transactions/stats')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.stats.totalRevenue).toBe(300);
      expect(res.body.stats.avgDailyRevenue).toBe(150);
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
  it('covers the 30 completed days the portal draws, not 29 of them', async () => {
    const parser = require('../../src/services/parser.service');
    const Transaction = require('../../src/models/Transaction.model');
    const tz = 'Africa/Johannesburg';
    const { token, user } = await createTestUser({
      email: 'cov@yourguava.com', cafeName: 'Cafe Cov', orgName: 'Org Cov',
    });
    // The token's own cafe, not whichever cafe happens to be first in the
    // collection - /transactions/status scopes to req.user.cafeId.
    const cafe = user.activeCafeId || user.cafeIds[0];

    // one sale exactly 30 completed days ago - the oldest cell the strip draws
    await Transaction.create({
      cafeId: cafe,
      date: parser.addZonedDays(new Date(), -30, tz),
      dayOfWeek: 1,
      hour: 9,
      total: 42,
      status: 'approved',
      items: [],
    });

    const res = await request.get('/api/transactions/status').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const oldest = parser.zonedDateKey(parser.addZonedDays(new Date(), -30, tz), tz);
    const keys = (res.body.data.coverage30d || []).map((c) => c.date);
    // Before this the window started at -29, so the portal's oldest cell was
    // always absent from the response and rendered as a gap that did not exist.
    expect(keys).toContain(oldest);
  });


});
