const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const {
  addZonedDays,
  getZonedDateParts,
  safeTimezone,
  zonedDateKey,
  zonedDateTimeToUtc,
  zonedDayOfWeek,
} = require('../../src/services/parser.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Forecasts API', () => {
  let token;
  let user;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
    user = testUser.user;
  });

  describe('GET /api/forecasts/today', () => {
    it('returns or generates forecast for today', async () => {
      const res = await request
        .get('/api/forecasts/today')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.forecast).toBeDefined();
      expect(res.body.forecast.date).toBeDefined();
      expect(res.body.forecast.signals).toBeDefined();
      expect(res.body.forecast.factors).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'weather' })])
      );
    });
  });

  describe('GET /api/forecasts/tomorrow', () => {
    it('returns or generates forecast for tomorrow', async () => {
      const res = await request
        .get('/api/forecasts/tomorrow')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.forecast).toBeDefined();
    });
  });

  describe('GET /api/forecasts/week', () => {
    it('returns 7 days of forecasts', async () => {
      const res = await request
        .get('/api/forecasts/week')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.forecasts).toBeDefined();
      expect(res.body.forecasts.length).toBe(7);
    });

    it('regenerates planning forecasts that are missing factor payloads', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Cafe = require('../../src/models/Cafe.model');
      const cafe = await Cafe.findOne({});
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      for (let i = 0; i < 7; i++) {
        const date = new Date(today);
        date.setDate(today.getDate() + i);
        await Forecast.create({
          cafeId: cafe._id,
          date,
          generatedAt: new Date('2026-01-01T00:00:00.000Z'),
          items: [],
          signals: {
            weather: { temp: 20, condition: 'clear', humidity: 60 },
            loadSheddingStage: 0,
            isPublicHoliday: false,
            isSchoolHoliday: false,
            isPayday: false,
            dayOfWeek: date.getDay(),
            events: [],
          },
          totalPredictedRevenue: 0,
        });
      }

      const res = await request
        .get('/api/forecasts/week')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.forecasts).toHaveLength(7);
      expect(res.body.forecasts[0].factors).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: 'weather' })])
      );
      expect(res.body.forecasts[0].factorSettings).toBeDefined();
      expect(res.body.forecasts[0].calibration).toEqual(
        expect.objectContaining({ sampleSize: expect.any(Number), overallMultiplier: expect.any(Number) })
      );
    });
  });

  describe('GET /api/forecasts/insights', () => {
    it('returns insights or fallback response', async () => {
      // Temporarily clear the API key to guarantee the fallback path
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const res = await request
        .get('/api/forecasts/insights')
        .set('Authorization', `Bearer ${token}`);

      // Restore key
      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.insights).toBeDefined();
      expect(Array.isArray(res.body.insights)).toBe(true);
      // Without ANTHROPIC_API_KEY, should return fallback message
      expect(res.body.insights[0]).toMatch(/API key/i);
    });
  });

  describe('Forecast factor settings', () => {
    it('returns default factor settings for the active cafe', async () => {
      const res = await request
        .get('/api/forecasts/factors')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.settings.payday.pct).toBe(20);
      expect(res.body.settings.events.enabled).toBe(false);
      expect(res.body.settings.events.highPct).toBe(35);
      expect(res.body.savedSettings.events.enabled).toBe(true);
      expect(res.body.entitlements.lockedKeys).toEqual(
        expect.arrayContaining(['events', 'payday', 'loadShedding', 'stock', 'history', 'learning'])
      );
    });

    it('updates factor settings and clears future forecasts for regeneration', async () => {
      await request.get('/api/forecasts/week').set('Authorization', `Bearer ${token}`);

      const Forecast = require('../../src/models/Forecast.model');
      expect(await Forecast.countDocuments({})).toBe(7);

      const res = await request
        .put('/api/forecasts/factors')
        .set('Authorization', `Bearer ${token}`)
        .send({ settings: { payday: { pct: 12 }, events: { highPct: 48 } } });

      expect(res.status).toBe(200);
      expect(res.body.savedSettings.payday.pct).toBe(12);
      expect(res.body.settings.payday.enabled).toBe(false);
      expect(res.body.settings.events.highPct).toBe(48);
      expect(await Forecast.countDocuments({})).toBe(0);
    });
  });

  describe('POST /api/forecasts/generate', () => {
    it('applies same-day local event factors with custom weighting', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Event = require('../../src/models/Event.model');
      const Organization = require('../../src/models/Organization.model');
      await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
      const cafe = await Cafe.findOne({});
      const target = new Date();
      target.setDate(target.getDate() + 3);
      target.setHours(12, 0, 0, 0);

      await Event.create({
        cafeId: cafe._id,
        name: 'Neighbourhood Market',
        date: target,
        impact: 'high',
        impactPct: 44,
      });

      const res = await request
        .post('/api/forecasts/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({ date: target.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.forecast.signals.events[0]).toEqual(
        expect.objectContaining({ name: 'Neighbourhood Market', impactPct: 44 })
      );
      expect(res.body.forecast.factors.find((f) => f.key === 'events')).toEqual(
        expect.objectContaining({ active: true, adjustmentPct: 44, multiplier: 1.44 })
      );
    });

    it('does not apply growth event factors on the starter plan', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Event = require('../../src/models/Event.model');
      const cafe = await Cafe.findOne({});
      const target = new Date();
      target.setDate(target.getDate() + 3);
      target.setHours(12, 0, 0, 0);

      await Event.create({
        cafeId: cafe._id,
        name: 'Starter Plan Market',
        date: target,
        impact: 'high',
        impactPct: 44,
      });

      const res = await request
        .post('/api/forecasts/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({ date: target.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.forecast.signals.events[0]).toEqual(
        expect.objectContaining({ name: 'Starter Plan Market', impactPct: 44 })
      );
      expect(res.body.forecast.factors.find((f) => f.key === 'events')).toEqual(
        expect.objectContaining({ active: false, adjustmentPct: 0, multiplier: 1 })
      );
      expect(res.body.forecast.factorEntitlements.lockedKeys).toEqual(expect.arrayContaining(['events']));
    });

    it('applies a bounded learning correction from past forecast errors', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Forecast = require('../../src/models/Forecast.model');
      const Item = require('../../src/models/Item.model');
      const Organization = require('../../src/models/Organization.model');
      const Transaction = require('../../src/models/Transaction.model');
      await Organization.findByIdAndUpdate(user.orgId, { plan: 'pro' });
      const cafe = await Cafe.findOne({});
      const target = new Date(2026, 5, 4);
      target.setHours(0, 0, 0, 0);
      const historyDate = new Date(target);
      historyDate.setDate(historyDate.getDate() - 7);
      historyDate.setHours(9, 0, 0, 0);

      await Item.create({
        cafeId: cafe._id,
        name: 'Flat White',
        category: 'coffee',
        avgPrice: 30,
      });

      await Transaction.create({
        cafeId: cafe._id,
        date: historyDate,
        hour: 9,
        dayOfWeek: target.getDay(),
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 10, unitPrice: 30 }],
        total: 300,
      });

      for (let i = 1; i <= 3; i++) {
        const forecastDate = new Date(target);
        forecastDate.setDate(target.getDate() - i);
        forecastDate.setHours(0, 0, 0, 0);
        await Forecast.create({
          cafeId: cafe._id,
          date: forecastDate,
          generatedAt: new Date(),
          items: [{ itemName: 'Flat White', predictedQty: 10, actualQty: 20, factors: [] }],
          signals: {
            weather: { temp: 20, condition: 'clear', humidity: 60 },
            loadSheddingStage: 0,
            isPublicHoliday: false,
            isSchoolHoliday: false,
            isPayday: false,
            dayOfWeek: forecastDate.getDay(),
            events: [],
          },
          factors: [],
          totalPredictedRevenue: 300,
          actualRevenue: 600,
          actualTransactionCount: 20,
          actualsUpdatedAt: new Date(),
          accuracy: 50,
        });
      }

      const res = await request
        .post('/api/forecasts/generate')
        .set('Authorization', `Bearer ${token}`)
        .send({ date: target.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.forecast.calibration.sampleSize).toBe(3);
      expect(res.body.forecast.calibration.overallMultiplier).toBe(1.15);
      expect(res.body.forecast.factors.find((f) => f.key === 'learning')).toEqual(
        expect.objectContaining({ active: true, multiplier: 1.15 })
      );
      expect(res.body.forecast.items[0]).toEqual(
        expect.objectContaining({ itemName: 'Flat White', baseQty: 10, predictedQty: 12 })
      );
    });
  });

  describe('POST /api/forecasts/insights/chat', () => {
    it('returns AI chat fallback when Anthropic key is missing', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const res = await request
        .post('/api/forecasts/insights/chat')
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: [{ role: 'user', content: 'What should I prep tomorrow?' }] });

      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.answer).toMatch(/API key/i);
      expect(res.body.generatedAt).toBeDefined();
    });
  });

  describe('POST /api/forecasts/insights/chat/stream', () => {
    it('streams AI chat fallback events when Anthropic key is missing', async () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const res = await request
        .post('/api/forecasts/insights/chat/stream')
        .set('Authorization', `Bearer ${token}`)
        .send({ messages: [{ role: 'user', content: 'What should I prep tomorrow?' }] });

      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      expect(res.text).toContain('event: delta');
      expect(res.text).toContain('AI chat requires');
      expect(res.text).toContain('event: done');
    });
  });

  describe('GET /api/forecasts/accuracy', () => {
    it('returns accuracy data (empty when no historical forecasts)', async () => {
      const res = await request
        .get('/api/forecasts/accuracy')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/forecasts/recent', () => {
    it('returns only past forecasts with matched actual sales data', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Cafe = require('../../src/models/Cafe.model');
      const cafe = await Cafe.findOne({});

      const unfilledDate = new Date();
      unfilledDate.setDate(unfilledDate.getDate() - 3);
      unfilledDate.setHours(0, 0, 0, 0);
      await Forecast.create({
        cafeId: cafe._id,
        date: unfilledDate,
        generatedAt: new Date(),
        items: [{ itemName: 'Flat White', predictedQty: 3 }],
        signals: { weather: { temp: 20, condition: 'clear', humidity: 60 }, loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [] },
        totalPredictedRevenue: 100,
      });

      const matchedDate = new Date();
      matchedDate.setDate(matchedDate.getDate() - 2);
      matchedDate.setHours(0, 0, 0, 0);
      await Forecast.create({
        cafeId: cafe._id,
        date: matchedDate,
        generatedAt: new Date(),
        items: [{ itemName: 'Flat White', predictedQty: 3, actualQty: 2 }],
        signals: { weather: { temp: 20, condition: 'clear', humidity: 60 }, loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [] },
        totalPredictedRevenue: 100,
        actualRevenue: 75,
        actualTransactionCount: 1,
        actualsUpdatedAt: new Date(),
        accuracy: 80,
      });

      const res = await request.get('/api/forecasts/recent').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.forecasts).toHaveLength(1);
      expect(res.body.forecasts[0].actualRevenue).toBe(75);
      expect(res.body.forecasts[0].items[0].actualQty).toBe(2);
    });
  });

  describe('GET /api/forecasts/history', () => {
    it('returns historical prediction vs actual revenue with factors and weather context', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Event = require('../../src/models/Event.model');
      const Forecast = require('../../src/models/Forecast.model');
      const Organization = require('../../src/models/Organization.model');
      const Transaction = require('../../src/models/Transaction.model');

      await Organization.findByIdAndUpdate(user.orgId, { plan: 'growth' });
      const cafe = await Cafe.findOne({});
      const timezone = safeTimezone(cafe.timezone);

      const target = addZonedDays(new Date(), -1, timezone);
      const dateKey = zonedDateKey(target, timezone);
      const oneWeekBeforeDay = addZonedDays(target, -7, timezone);
      const oneWeekBefore = zonedDateTimeToUtc(
        { ...getZonedDateParts(oneWeekBeforeDay, timezone), hour: 9, minute: 0, second: 0 },
        timezone
      );
      const targetDayOfWeek = zonedDayOfWeek(target, timezone);

      await Transaction.create({
        cafeId: cafe._id,
        date: oneWeekBefore,
        hour: 9,
        dayOfWeek: targetDayOfWeek,
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 10, unitPrice: 32 }],
        total: 320,
      });

      await Transaction.create({
        cafeId: cafe._id,
        date: target,
        hour: 10,
        dayOfWeek: targetDayOfWeek,
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 12, unitPrice: 32 }],
        total: 384,
      });

      await Event.create({
        cafeId: cafe._id,
        name: 'Local Market',
        date: target,
        impact: 'medium',
        impactPct: 22,
      });

      const res = await request
        .get(`/api/forecasts/history?startDate=${dateKey}&endDate=${dateKey}&backfill=sync&backfillLimit=1`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.history).toHaveLength(1);

      const row = res.body.history[0];
      expect(row.actualRevenue).toBe(384);
      expect(row.predictedRevenue).toBeGreaterThan(0);
      expect(row.variance).toBeCloseTo(row.actualRevenue - row.predictedRevenue, 2);
      expect(row.revenueAccuracy).toEqual(expect.any(Number));
      expect(row.transactionCount).toBe(1);
      expect(row.weather).toEqual(expect.objectContaining({ condition: expect.any(String) }));
      if (row.weather.available === false) {
        expect(row.weather.unavailableReason).toEqual(expect.any(String));
      } else {
        expect(row.weather.temp).toEqual(expect.any(Number));
      }
      expect(row.signals.events).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Local Market' })]));
      expect(row.activeFactors).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'events' })]));
      expect(row.calibration).toEqual(
        expect.objectContaining({ sampleSize: expect.any(Number), overallMultiplier: expect.any(Number) })
      );
      expect(row.trainingData).toEqual(expect.objectContaining({ transactionCount: 1, weeksWithSales: 1 }));
      expect(res.body.meta.overallRevenueAccuracy).toEqual(expect.any(Number));
      expect(res.body.meta.avgDailyRevenueAccuracy).toEqual(expect.any(Number));
      expect(res.body.meta.avgRevenueAccuracy).toBe(res.body.meta.avgDailyRevenueAccuracy);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ total: 1, page: 1, limit: 30, pages: 1 })
      );

      const stored = await Forecast.findOne({ cafeId: cafe._id, date: target }).lean();
      expect(stored.actualRevenue).toBe(384);
      expect(stored.totalPredictedRevenue).toBeGreaterThan(0);
    });

    it('paginates historical prediction rows while keeping full-period summary totals', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Forecast = require('../../src/models/Forecast.model');
      const Transaction = require('../../src/models/Transaction.model');
      const cafe = await Cafe.findOne({});

      for (let index = 0; index < 5; index += 1) {
        const date = new Date('2026-05-20T00:00:00.000Z');
        date.setDate(date.getDate() - index);
        const transactionDate = new Date(date);
        transactionDate.setHours(10, 0, 0, 0);

        await Forecast.create({
          cafeId: cafe._id,
          date,
          totalPredictedRevenue: 100,
          predictedTransactionCount: 5,
          actualRevenue: 120,
          actualTransactionCount: 1,
          accuracy: 83.3,
          actualsUpdatedAt: new Date(),
          items: [],
          factors: [
            { key: 'weather', label: 'Weather', active: false },
            { key: 'loadShedding', label: 'Load shedding', active: false },
            { key: 'holiday', label: 'Holiday', active: false },
            { key: 'payday', label: 'Payday', active: false },
            { key: 'events', label: 'Events', active: false },
          ],
          factorSettings: { weather: { enabled: true } },
          factorEntitlements: { weather: { enabled: true } },
          calibration: { sampleSize: 1, overallMultiplier: 1, factorMultipliers: [], itemMultipliers: [] },
          signals: {
            weather: { temp: 18, condition: 'Clear', humidity: 60 },
            loadSheddingStage: 0,
            isPublicHoliday: false,
            isSchoolHoliday: false,
            isPayday: false,
            dayOfWeek: date.getDay(),
            events: [],
          },
        });

        await Transaction.create({
          cafeId: cafe._id,
          date: transactionDate,
          hour: 10,
          dayOfWeek: date.getDay(),
          status: 'approved',
          items: [{ name: 'Flat White', quantity: 1, unitPrice: 120 }],
          total: 120,
        });
      }

      const res = await request
        .get('/api/forecasts/history?startDate=2026-05-01&endDate=2026-05-20&page=2&limit=2&backfill=false')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(2);
      expect(res.body.pagination).toEqual(
        expect.objectContaining({ total: 5, page: 2, limit: 2, pages: 3 })
      );
      expect(res.body.meta.totalRows).toBe(5);
      expect(res.body.meta.totalPredictedRevenue).toBe(500);
      expect(res.body.meta.totalActualRevenue).toBe(600);
    });

    it('returns quickly with pending metadata when history needs backfill', async () => {
      const Cafe = require('../../src/models/Cafe.model');
      const Transaction = require('../../src/models/Transaction.model');
      const cafe = await Cafe.findOne({});
      const target = new Date();
      target.setDate(target.getDate() - 2);
      target.setHours(0, 0, 0, 0);
      const dateKey = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;

      await Transaction.create({
        cafeId: cafe._id,
        date: target,
        hour: 10,
        dayOfWeek: target.getDay(),
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 3, unitPrice: 32 }],
        total: 96,
      });

      const res = await request
        .get(`/api/forecasts/history?startDate=${dateKey}&endDate=${dateKey}&backfill=false`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.history).toHaveLength(0);
      expect(res.body.meta.totalTradingDays).toBe(1);
      expect(res.body.meta.pendingDays).toBe(1);
      expect(res.body.meta.isPartial).toBe(true);
      expect(res.body.meta.backfill.status).toBe('running');
      expect(res.body.meta.overallRevenueAccuracy).toBeNull();
      expect(res.body.meta.avgDailyRevenueAccuracy).toBeNull();
    });
  });

  describe('updateForecastActuals', () => {
    it('leaves actuals empty when there are no transactions for that date', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Cafe = require('../../src/models/Cafe.model');
      const { updateForecastActuals } = require('../../src/services/forecast.service');
      const cafe = await Cafe.findOne({});
      const date = new Date();
      date.setDate(date.getDate() - 1);
      date.setHours(0, 0, 0, 0);

      await Forecast.create({
        cafeId: cafe._id,
        date,
        generatedAt: new Date(),
        items: [{ itemName: 'Flat White', predictedQty: 3, actualQty: 0 }],
        signals: { weather: { temp: 20, condition: 'clear', humidity: 60 }, loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [] },
        totalPredictedRevenue: 100,
      });

      const updated = await updateForecastActuals(cafe._id, date);
      const json = updated.toObject();

      expect(json.actualsUpdatedAt).toBeUndefined();
      expect(json.actualRevenue).toBeUndefined();
      expect(json.actualTransactionCount).toBeUndefined();
      expect(json.accuracy).toBeUndefined();
      expect(json.items[0].actualQty).toBeUndefined();
    });

    it('stores actual revenue and item quantities when transactions exist', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Transaction = require('../../src/models/Transaction.model');
      const Cafe = require('../../src/models/Cafe.model');
      const { updateForecastActuals } = require('../../src/services/forecast.service');
      const cafe = await Cafe.findOne({});
      const date = new Date();
      date.setDate(date.getDate() - 1);
      date.setHours(0, 0, 0, 0);

      await Forecast.create({
        cafeId: cafe._id,
        date,
        generatedAt: new Date(),
        items: [
          { itemName: 'Flat White', predictedQty: 2 },
          { itemName: 'Brownie', predictedQty: 1 },
        ],
        signals: { weather: { temp: 20, condition: 'clear', humidity: 60 }, loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [] },
        totalPredictedRevenue: 100,
      });

      await Transaction.create({
        cafeId: cafe._id,
        date,
        hour: 9,
        dayOfWeek: date.getDay(),
        status: 'approved',
        items: [{ name: 'Flat White', quantity: 2, unitPrice: 24 }],
        total: 48,
      });

      const updated = await updateForecastActuals(cafe._id, date);
      const json = updated.toObject();

      expect(json.actualRevenue).toBe(48);
      expect(json.actualTransactionCount).toBe(1);
      expect(json.actualsUpdatedAt).toBeDefined();
      expect(json.items.find((item) => item.itemName === 'Flat White').actualQty).toBe(2);
      expect(json.items.find((item) => item.itemName === 'Brownie').actualQty).toBe(0);
      expect(json.accuracy).toBe(50);
    });
  });
});
