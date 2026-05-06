const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Forecasts API', () => {
  let token;

  beforeEach(async () => {
    const testUser = await createTestUser();
    token = testUser.token;
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
