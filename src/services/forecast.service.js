const Transaction = require('../models/Transaction.model');
const Item = require('../models/Item.model');
const Forecast = require('../models/Forecast.model');
const Event = require('../models/Event.model');
const Cafe = require('../models/Cafe.model');
const { getSignalsForDate } = require('../utils/signals');
const { getWeatherForecast } = require('./weather.service');

// Weighted moving average weights (most recent first)
const WEIGHTS = [0.35, 0.25, 0.20]; // weeks 1, 2, 3
// Remaining weight (0.20) is split evenly across weeks 4-8
const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Applies a weather modifier to a predicted quantity based on item category and weather conditions.
 */
const weatherModifier = (category, weather) => {
  let mod = 1.0;

  if (!weather) return mod;

  const { temp, isRain } = weather;

  if (temp > 27) {
    if (category === 'cold_drink') mod += 0.30;
    if (category === 'coffee') mod -= 0.10;
  } else if (temp < 18) {
    if (category === 'coffee') mod += 0.15;
    if (category === 'cold_drink') mod -= 0.20;
  }

  if (isRain) {
    mod -= 0.10;
  }

  return Math.max(mod, 0.1); // never go below 10%
};

/**
 * Returns a load shedding multiplier based on the current stage.
 */
const loadSheddingModifier = (stage) => {
  if (stage === 0) return 1.0;
  if (stage <= 2) return 0.92;
  if (stage <= 4) return 0.78;
  return 0.60; // stage 5+
};

/**
 * Returns a holiday multiplier.
 */
const holidayModifier = (isPublicHoliday, isSchoolHoliday) => {
  if (isPublicHoliday && isSchoolHoliday) return 1.20;
  if (isPublicHoliday) return 1.15;
  if (isSchoolHoliday) return 1.08;
  return 1.0;
};

/**
 * Returns a payday multiplier.
 */
const paydayModifier = (isPayday) => (isPayday ? 1.20 : 1.0);

/**
 * Returns an events multiplier based on the highest-impact event.
 * low = +10%, medium = +20%, high = +35%
 */
const eventsModifier = (events) => {
  if (!events || events.length === 0) return 1.0;
  const impactMap = { low: 1.10, medium: 1.20, high: 1.35 };
  const maxImpact = Math.max(...events.map((e) => impactMap[e.impact] || 1.0));
  return maxImpact;
};

/**
 * Groups transactions by week bucket (most recent = bucket 0) and by item name.
 * Returns: Map<itemName, number[]> where each number is the quantity sold that week.
 */
const groupByWeekAndItem = (transactions, targetDate) => {
  const target = new Date(targetDate);

  // Bucket index: 0 = this week, 1 = last week, etc.
  const getBucket = (txDate) => {
    const diffMs = target - new Date(txDate);
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return Math.floor(diffDays / 7);
  };

  const itemWeekMap = new Map(); // itemName -> { bucketIndex: qty }

  for (const tx of transactions) {
    if (!tx.items || tx.items.length === 0) continue;
    const bucket = getBucket(tx.date);
    for (const item of tx.items) {
      if (!item.name) continue;
      if (!itemWeekMap.has(item.name)) {
        itemWeekMap.set(item.name, {});
      }
      const buckets = itemWeekMap.get(item.name);
      buckets[bucket] = (buckets[bucket] || 0) + item.quantity;
    }
  }

  return itemWeekMap;
};

/**
 * Computes weighted moving average for an item's weekly quantity history.
 * Uses the actual populated bucket indices, sorted from most recent (smallest) to oldest,
 * making the algorithm robust to historical data even when recent weeks are empty.
 * @param {{ [bucketIndex: number]: number }} buckets
 * @returns {number}
 */
const weightedAverage = (buckets) => {
  // Use the ACTUAL populated bucket indices, sorted from most recent (smallest) to oldest.
  const sortedKeys = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, 8); // cap at 8 weeks
  const numWeeks = sortedKeys.length;
  if (numWeeks === 0) return 0;

  // Build weights for the available buckets
  let weights;
  if (numWeeks === 1) {
    weights = [1.0];
  } else if (numWeeks === 2) {
    weights = [0.6, 0.4];
  } else {
    const remainingWeight = 1.0 - WEIGHTS[0] - WEIGHTS[1] - WEIGHTS[2];
    const olderWeeks = numWeeks - 3;
    const olderWeightPerWeek = olderWeeks > 0 ? remainingWeight / olderWeeks : 0;
    weights = [];
    for (let i = 0; i < numWeeks; i++) {
      weights.push(i < WEIGHTS.length ? WEIGHTS[i] : olderWeightPerWeek);
    }
  }

  let total = 0;
  for (let i = 0; i < numWeeks; i++) {
    const bucketKey = sortedKeys[i];
    const qty = buckets[bucketKey] || 0;
    total += qty * weights[i];
  }
  return total;
};

/**
 * Computes a suggested stock quantity for a given item based on historical forecast bias.
 * Uses the last 30 days of forecast docs where actualQty was recorded.
 *
 * @param {string|ObjectId} cafeId
 * @param {string} itemName
 * @param {number} predictedQty
 * @returns {Promise<number>}
 */
const computeSuggestedStock = async (cafeId, itemName, predictedQty) => {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const pastForecasts = await Forecast.find({
    cafeId,
    date: { $gte: thirtyDaysAgo },
    'items.itemName': itemName,
    'items.actualQty': { $gt: 0 },
  })
    .select('items')
    .lean();

  // Extract matched item pairs (predicted vs actual)
  const pairs = [];
  for (const doc of pastForecasts) {
    for (const item of doc.items || []) {
      if (item.itemName === itemName && item.actualQty > 0 && item.predictedQty != null) {
        pairs.push({ predicted: item.predictedQty, actual: item.actualQty });
      }
    }
  }

  const SAFETY_MARGIN = 1.10;

  if (pairs.length >= 3) {
    const avgBias = pairs.reduce((sum, p) => {
      const bias = (p.actual - p.predicted) / Math.max(p.predicted, 1);
      return sum + Math.max(-0.5, Math.min(0.5, bias));
    }, 0) / pairs.length;

    const biasAdjusted = Math.round(predictedQty * (1 + avgBias) * SAFETY_MARGIN);
    return Math.max(predictedQty, biasAdjusted);
  }

  // Cold start: just apply the safety margin
  return Math.round(predictedQty * SAFETY_MARGIN);
};

/**
 * Generates a sales forecast for a cafe on a specific target date.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} targetDate
 * @returns {Promise<Forecast>}
 */
const generateForecast = async (cafeId, targetDate) => {
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const targetDayOfWeek = target.getDay();

  // Fetch last 8 weeks of same-day-of-week transactions
  const eightWeeksAgo = new Date(target);
  eightWeeksAgo.setDate(eightWeeksAgo.getDate() - 56);

  const transactions = await Transaction.find({
    cafeId,
    dayOfWeek: targetDayOfWeek,
    status: 'approved',
    date: { $gte: eightWeeksAgo, $lt: target },
  }).lean();

  const historyDates = transactions.map((tx) => new Date(tx.date));
  const firstTransactionDate =
    historyDates.length > 0 ? new Date(Math.min(...historyDates.map((date) => date.getTime()))) : undefined;
  const lastTransactionDate =
    historyDates.length > 0 ? new Date(Math.max(...historyDates.map((date) => date.getTime()))) : undefined;
  const weeksWithSales = new Set(
    historyDates.map((date) => Math.floor((target - date) / MS_PER_DAY / 7))
  ).size;
  const staleDays =
    lastTransactionDate != null ? Math.max(0, Math.floor((target - lastTransactionDate) / MS_PER_DAY)) : undefined;

  // Get cafe location for weather
  const cafe = await Cafe.findById(cafeId).lean();
  const lat = cafe?.location?.lat || -33.9249; // Cape Town default
  const lng = cafe?.location?.lng || 18.4241;

  // Fetch signals, weather, and events in parallel
  const [signals, weather, events] = await Promise.all([
    getSignalsForDate(target, { lat, lng }),
    getWeatherForecast(lat, lng, target),
    Event.find({ cafeId, date: target }).lean(),
  ]);

  // Group transactions by week and item
  const itemWeekMap = groupByWeekAndItem(transactions, target);

  // Get top 15 items by total historical frequency
  const itemTotals = [];
  for (const [name, buckets] of itemWeekMap.entries()) {
    const total = Object.values(buckets).reduce((s, v) => s + v, 0);
    itemTotals.push({ name, total });
  }
  itemTotals.sort((a, b) => b.total - a.total);
  const topItems = itemTotals.slice(0, 15).map((i) => i.name);

  // Fetch item categories
  const itemDocs = await Item.find({ cafeId, name: { $in: topItems } }).lean();
  const categoryMap = new Map(itemDocs.map((i) => [i.name, i.category]));

  // Calculate predicted quantities with modifiers
  const loadMod = loadSheddingModifier(signals.loadSheddingStage);
  const holidayMod = holidayModifier(signals.isPublicHoliday, signals.isSchoolHoliday);
  const paydayMod = paydayModifier(signals.isPayday);
  const eventMod = eventsModifier(events);

  const forecastItems = [];
  let totalPredictedRevenue = 0;

  for (const name of topItems) {
    const buckets = itemWeekMap.get(name) || {};
    const baseQty = weightedAverage(buckets);
    const category = categoryMap.get(name) || 'other';
    const weatherMod = weatherModifier(category, weather);

    const finalQty = Math.round(baseQty * weatherMod * loadMod * holidayMod * paydayMod * eventMod);

    // Estimate revenue using item avgPrice if available
    const itemDoc = itemDocs.find((d) => d.name === name);
    const avgPrice = itemDoc?.avgPrice || 0;
    totalPredictedRevenue += finalQty * avgPrice;

    forecastItems.push({
      itemName: name,
      predictedQty: finalQty,
      suggestedStock: await computeSuggestedStock(cafeId, name, finalQty),
    });
  }

  // Upsert forecast document
  const forecast = await Forecast.findOneAndUpdate(
    { cafeId, date: target },
    {
      $set: {
        generatedAt: new Date(),
        items: forecastItems,
        signals: {
          weather: {
            temp: weather.temp,
            condition: weather.condition,
            humidity: weather.humidity,
          },
          loadSheddingStage: signals.loadSheddingStage,
          isPublicHoliday: signals.isPublicHoliday,
          isSchoolHoliday: signals.isSchoolHoliday,
          isPayday: signals.isPayday,
          dayOfWeek: targetDayOfWeek,
          events: events.map((e) => ({ name: e.name, impact: e.impact })),
        },
        totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
        trainingData: {
          transactionCount: transactions.length,
          firstTransactionDate,
          lastTransactionDate,
          weeksWithSales,
          staleDays,
        },
      },
      $unset: {
        accuracy: '',
        actualRevenue: '',
        actualTransactionCount: '',
        actualsUpdatedAt: '',
      },
    },
    { upsert: true, new: true }
  );

  return forecast;
};

/**
 * Generates forecasts for the next 7 days.
 * @param {string|ObjectId} cafeId
 * @returns {Promise<Forecast[]>}
 */
const generateWeekForecast = async (cafeId) => {
  const forecasts = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + i);
    const forecast = await generateForecast(cafeId, targetDate);
    forecasts.push(forecast);
  }

  return forecasts;
};

/**
 * Pulls actual transactions for a given date and updates forecast accuracy.
 * Accuracy = 1 - MAE/mean(actuals), expressed as a percentage.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} date
 * @returns {Promise<Forecast|null>}
 */
const updateForecastActuals = async (cafeId, date) => {
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  const nextDay = new Date(target);
  nextDay.setDate(nextDay.getDate() + 1);

  const forecast = await Forecast.findOne({ cafeId, date: target });
  if (!forecast) return null;

  // Fetch actual transactions for that date
  const transactions = await Transaction.find({
    cafeId,
    status: 'approved',
    date: { $gte: target, $lt: nextDay },
  }).lean();

  if (transactions.length === 0) {
    for (const fi of forecast.items) {
      fi.actualQty = undefined;
    }
    forecast.accuracy = undefined;
    forecast.actualRevenue = undefined;
    forecast.actualTransactionCount = undefined;
    forecast.actualsUpdatedAt = undefined;
    forecast.markModified('items');
    await forecast.save();
    return forecast;
  }

  // Sum actual quantities per item
  const actualMap = new Map();
  let actualRevenue = 0;
  for (const tx of transactions) {
    actualRevenue += tx.total || 0;
    for (const item of tx.items || []) {
      actualMap.set(item.name, (actualMap.get(item.name) || 0) + item.quantity);
    }
  }

  // Update actualQty on each forecast item
  let totalAbsError = 0;
  let totalActual = 0;

  for (const fi of forecast.items) {
    fi.actualQty = actualMap.get(fi.itemName) || 0;
    totalAbsError += Math.abs(fi.predictedQty - fi.actualQty);
    totalActual += fi.actualQty;
  }

  // MAPE-style accuracy: clamp between 0 and 100
  const accuracy =
    totalActual > 0
      ? Math.max(0, Math.min(100, (1 - totalAbsError / totalActual) * 100))
      : null;

  forecast.accuracy = accuracy !== null ? parseFloat(accuracy.toFixed(1)) : undefined;
  forecast.actualRevenue = parseFloat(actualRevenue.toFixed(2));
  forecast.actualTransactionCount = transactions.length;
  forecast.actualsUpdatedAt = new Date();
  await forecast.save();

  return forecast;
};

module.exports = {
  generateForecast,
  generateWeekForecast,
  updateForecastActuals,
};
