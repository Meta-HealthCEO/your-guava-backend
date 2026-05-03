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
    it('returns forecasts from the past 7 days', async () => {
      const Forecast = require('../../src/models/Forecast.model');
      const Cafe = require('../../src/models/Cafe.model');
      const cafe = await Cafe.findOne({});
      // Create one past forecast (3 days ago)
      const date = new Date();
      date.setDate(date.getDate() - 3);
      date.setHours(0, 0, 0, 0);
      await Forecast.create({
        cafeId: cafe._id,
        date,
        generatedAt: new Date(),
        items: [],
        signals: { weather: { temp: 20, condition: 'clear', humidity: 60 }, loadSheddingStage: 0, isPublicHoliday: false, isSchoolHoliday: false, isPayday: false, dayOfWeek: 0, events: [] },
        totalPredictedRevenue: 100,
      });

      const res = await request.get('/api/forecasts/recent').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.forecasts).toHaveLength(1);
    });
  });
});
