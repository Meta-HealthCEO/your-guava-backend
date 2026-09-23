const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('PUT /api/cafe/me rejects bad input instead of coercing it', () => {
  let owner;
  beforeEach(async () => {
    owner = await createTestUser({ email: 'cafe-validation@yourguava.com' });
  });

  it.each([
    [{ name: null }],
    [{ name: 42 }],
    [{ name: ' ' }],
    [{ tradingHours: null }],
    [{ tradingHours: {} }],
    [{ tradingHours: [{ dayOfWeek: 9, isOpen: true, openTime: '07:00', closeTime: '17:00' }] }],
    [{ tradingHours: [{ dayOfWeek: 1, isOpen: 'yes' }] }],
    [{ tradingHours: [{ dayOfWeek: 1, isOpen: true, openTime: '7am', closeTime: '17:00' }] }],
  ])('answers 400 for %j', async (body) => {
    const res = await request.put('/api/cafe/me').set('Authorization', `Bearer ${owner.token}`).send(body);
    expect(res.status).toBe(400);
  });

  it('leaves the name, the hours and every future forecast untouched after a rejected update', async () => {
    const cafeId = owner.user.activeCafeId;
    await Forecast.create({ cafeId, date: new Date(Date.now() + 2 * 86_400_000), totalPredictedRevenue: 1000, items: [] });
    const before = await Cafe.findById(cafeId).lean();
    await request.put('/api/cafe/me').set('Authorization', `Bearer ${owner.token}`).send({ name: null, tradingHours: {} });
    const after = await Cafe.findById(cafeId).lean();
    expect(after.name).toBe(before.name);
    expect(after.tradingHours).toEqual(before.tradingHours);
    expect(await Forecast.countDocuments({ cafeId })).toBe(1);
  });

  it('still accepts a well-formed update', async () => {
    const res = await request.put('/api/cafe/me').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Renamed Cafe' });
    expect(res.status).toBe(200);
    expect(res.body.cafe.name).toBe('Renamed Cafe');
  });
});
