/**
 * End-to-end proof of the core product loop:
 *   POS export upload → column mapping → ingestion → forecast generation.
 *
 * Generates 8 weeks of realistic Yoco-format sales history with a known
 * weekday pattern, pushes it through the real HTTP pipeline, and asserts
 * the prediction model produces per-item forecasts that track that pattern.
 */
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
const Cafe = require('../../src/models/Cafe.model');
const Transaction = require('../../src/models/Transaction.model');
const Item = require('../../src/models/Item.model');
const {
  addZonedDays,
  safeTimezone,
  zonedDateKey,
  zonedDayOfWeek,
  zonedDayStart,
} = require('../../src/services/parser.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

const PRICES = { 'Flat White': 40, Cappuccino: 38, Croissant: 35 };

// Same-weekday quantity pattern the model should learn:
// Flat Whites scale with the weekday, Cappuccinos and Croissants are flat.
const flatWhiteQtyFor = (dayOfWeek) => 5 + dayOfWeek; // Sun=5 ... Sat=11

const yocoDate = (date, timezone) => zonedDateKey(date, timezone).replaceAll('-', '/');

/**
 * Builds a Yoco-format CSV covering the past `days` days (ending yesterday),
 * one receipt per item type per day.
 */
const buildHistoryCsv = (days = 56, timezone = 'Africa/Johannesburg') => {
  const header =
    'Receipt,Date,Time,Status,Payment Method,Order Number,Card Reader,Items,Note,Currency,Tip,Discount,VAT,Total (incl. tax),Fee Amount,Net Amount';
  const rows = [header];
  let receiptCounter = 1;
  const today = zonedDayStart(new Date(), timezone);

  for (let daysAgo = days; daysAgo >= 1; daysAgo--) {
    const date = addZonedDays(today, -daysAgo, timezone);

    const sales = [
      ['Flat White', flatWhiteQtyFor(zonedDayOfWeek(date, timezone))],
      ['Cappuccino', 4],
      ['Croissant', 3],
    ];

    for (const [item, qty] of sales) {
      const total = (qty * PRICES[item]).toFixed(2);
      rows.push(
        `R-${String(receiptCounter++).padStart(6, '0')},${yocoDate(date, timezone)},09:30:00,Approved,Credit Card,#${receiptCounter},,${qty} x ${item},,ZAR,0.0,0.0,0.0,${total},0.0,${total}`
      );
    }
  }

  return rows.join('\n');
};

describe('POS upload → forecast pipeline (end-to-end)', () => {
  let token;
  let timezone;

  beforeEach(async () => {
    const u = await createTestUser();
    token = u.token;
    // This synthetic fixture records sales on every weekday, including
    // Sunday, so its configured operating schedule must match that premise.
    const cafe = await Cafe.findOne({});
    cafe.tradingHours = Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      isOpen: true,
      openTime: '07:00',
      closeTime: '17:00',
    }));
    await cafe.save();
    timezone = safeTimezone(cafe?.timezone);
  });

  it('ingests a Yoco export and produces working per-item predictions', async () => {
    const csv = buildHistoryCsv(56, timezone);
    const expectedRows = 56 * 3;

    // 1. Stage the upload — Yoco format must be auto-detected (no wizard needed)
    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv), 'yoco-export.csv');

    expect(stage.status).toBe(200);
    expect(stage.body.uploadId).toBeDefined();
    expect(stage.body.needsConfirmation).toBe(false);

    // 2. Confirm — parses, ingests, and triggers forecast generation
    const confirm = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });

    expect(confirm.status).toBe(200);
    expect(confirm.body.success).toBe(true);
    expect(confirm.body.stats.imported).toBe(expectedRows);

    // 3. Transactions are persisted and approved
    const txnCount = await Transaction.countDocuments({ status: 'approved' });
    expect(txnCount).toBe(expectedRows);

    // 4. Menu items were reconciled from the sales data
    const items = await Item.find({}).lean();
    const itemNames = items.map((i) => i.name);
    expect(itemNames).toEqual(
      expect.arrayContaining(['Flat White', 'Cappuccino', 'Croissant'])
    );

    // 5. The week forecast exists with per-item predictions
    const week = await request
      .get('/api/forecasts/week')
      .set('Authorization', `Bearer ${token}`);

    expect(week.status).toBe(200);
    expect(week.body.forecasts).toHaveLength(7);

    for (const forecast of week.body.forecasts) {
      expect(forecast.items.length).toBeGreaterThan(0);
      expect(forecast.totalPredictedRevenue).toBeGreaterThan(0);
      for (const item of forecast.items) {
        expect(item.predictedQty).toBeGreaterThan(0);
        expect(item.suggestedStock).toBeGreaterThanOrEqual(item.predictedQty);
      }
    }

    // 6. Predictions track the historical weekday pattern.
    //    Factors (holidays etc.) can shift them, so allow a generous band.
    for (const forecast of week.body.forecasts) {
      const forecastDay = zonedDayOfWeek(forecast.date, timezone);
      const flatWhite = forecast.items.find((i) => i.itemName === 'Flat White');
      const croissant = forecast.items.find((i) => i.itemName === 'Croissant');

      expect(flatWhite).toBeDefined();
      expect(croissant).toBeDefined();

      const expectedFlatWhite = flatWhiteQtyFor(forecastDay);
      expect(flatWhite.predictedQty).toBeGreaterThanOrEqual(Math.floor(expectedFlatWhite * 0.6));
      expect(flatWhite.predictedQty).toBeLessThanOrEqual(Math.ceil(expectedFlatWhite * 1.6));

      expect(croissant.predictedQty).toBeGreaterThanOrEqual(2);
      expect(croissant.predictedQty).toBeLessThanOrEqual(5);
    }

    // 7. Today's forecast endpoint serves the same model output
    const today = await request
      .get('/api/forecasts/today')
      .set('Authorization', `Bearer ${token}`);

    expect(today.status).toBe(200);
    expect(today.body.forecast).toBeTruthy();
    expect(today.body.forecast.items.length).toBeGreaterThan(0);

    // 8. Transaction stats reflect the ingested data (Dashboard depends on this)
    const stats = await request
      .get('/api/transactions/stats')
      .set('Authorization', `Bearer ${token}`);

    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalTransactions).toBe(expectedRows);
  }, 60000);

  it('backfills history and reports prediction-vs-actual accuracy', async () => {
    const csv = buildHistoryCsv(56, timezone);

    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv), 'yoco-export.csv');
    const confirm = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({ columnMapping: stage.body.columnMapping, itemsMode: stage.body.itemsMode });
    expect(confirm.status).toBe(200);

    // Synchronously backfill retro-forecasts for the last 5 trading days
    const history = await request
      .get('/api/forecasts/history?days=5&backfill=sync&backfillLimit=5')
      .set('Authorization', `Bearer ${token}`);

    expect(history.status).toBe(200);
    const rows = history.body.rows;
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      // Each history row compares the model's prediction against real sales
      expect(row.predictedRevenue).toBeGreaterThan(0);
      expect(row.actualRevenue).toBeGreaterThan(0);
      expect(row.revenueAccuracy).not.toBeNull();
      // The synthetic data is perfectly regular, so accuracy should be high
      expect(row.revenueAccuracy).toBeGreaterThan(60);
    }

    expect(history.body.meta.overallRevenueAccuracy).toBeGreaterThan(60);
  }, 60000);

  it('ingests a generic POS export via explicit column mapping and still forecasts', async () => {
    // Generic (non-Yoco) headers — requires the mapping wizard path
    const header = 'Sale Date,Products,Amount Due';
    const rows = [header];
    const today = zonedDayStart(new Date(), timezone);
    for (let daysAgo = 28; daysAgo >= 1; daysAgo--) {
      const date = addZonedDays(today, -daysAgo, timezone);
      rows.push(`${yocoDate(date, timezone)},4 x Americano,140.00`);
    }
    const csv = rows.join('\n');

    const stage = await request
      .post('/api/transactions/upload')
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from(csv), 'generic-pos.csv');

    expect(stage.status).toBe(200);
    expect(stage.body.needsConfirmation).toBe(true);

    const confirm = await request
      .post(`/api/uploads/${stage.body.uploadId}/confirm`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        columnMapping: { date: 'Sale Date', items: 'Products', total: 'Amount Due' },
        itemsMode: 'packed',
      });

    expect(confirm.status).toBe(200);
    expect(confirm.body.stats.imported).toBe(28);

    const week = await request
      .get('/api/forecasts/week')
      .set('Authorization', `Bearer ${token}`);

    expect(week.status).toBe(200);
    const withAmericano = week.body.forecasts.filter((f) =>
      f.items.some((i) => i.itemName === 'Americano' && i.predictedQty > 0)
    );
    expect(withAmericano.length).toBe(7);
  }, 60000);
});
