const { setup, teardown, clearDB, createTestUser } = require('../setup');
const Cafe = require('../../src/models/Cafe.model');
const Forecast = require('../../src/models/Forecast.model');
const Transaction = require('../../src/models/Transaction.model');
const { updateForecastActuals } = require('../../src/services/forecast.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.useRealTimers();
  await clearDB();
});

// Only Date is faked: Mongo's driver keeps its real timers, clock and microtasks.
const fakeDateOnly = (now) => jest.useFakeTimers({
  now,
  doNotFake: [
    'hrtime', 'nextTick', 'performance', 'queueMicrotask',
    'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout',
  ],
});

describe('forecast fixtures built from host-local midnights', () => {
  it('does not score today when the suite runs at 23:00 UTC, which is 01:00 the next day in the cafe zone', async () => {
    await createTestUser();
    const cafe = await Cafe.findOne({});
    fakeDateOnly(new Date('2026-09-22T23:00:00.000Z'));

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await Forecast.create({
      cafeId: cafe._id,
      date: today,
      origin: 'live',
      generatedAt: new Date(),
      items: [{ itemName: 'Flat White', predictedQty: 40 }],
      signals: {
        weather: { temp: 20, condition: 'clear', humidity: 60 },
        loadSheddingStage: 0,
        isPublicHoliday: false,
        isSchoolHoliday: false,
        isPayday: false,
        dayOfWeek: today.getDay(),
        events: [],
      },
      totalPredictedRevenue: 920,
    });
    const morning = new Date();
    morning.setHours(8, 5, 0, 0);
    await Transaction.create({
      cafeId: cafe._id,
      date: morning,
      hour: 8,
      dayOfWeek: morning.getDay(),
      status: 'approved',
      items: [{ name: 'Flat White', quantity: 2, unitPrice: 50 }],
      total: 100,
      source: 'csv',
    });

    const json = (await updateForecastActuals(cafe._id, today)).toObject();

    expect(json.accuracy).toBeUndefined();
    expect(json.actualRevenue).toBeUndefined();
  });
});
