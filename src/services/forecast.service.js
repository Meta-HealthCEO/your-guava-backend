const Transaction = require('../models/Transaction.model');
const Item = require('../models/Item.model');
const Forecast = require('../models/Forecast.model');
const Event = require('../models/Event.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const { getSignalsForDate } = require('../utils/signals');
const { getWeatherForecast } = require('./weather.service');
const {
  getForecastSettings,
  getFactorEntitlements,
  factorUnlocked,
  buildGlobalFactors,
  buildItemFactors,
  multiplyFactors,
} = require('./forecastFactors.service');

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const CALIBRATION_LOOKBACK_DAYS = 60;
const MIN_OVERALL_CALIBRATION_SAMPLES = 3;
const MIN_FACTOR_CALIBRATION_SAMPLES = 3;
const MIN_ITEM_CALIBRATION_SAMPLES = 3;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const accumulateRatio = (bucket, ratio, weight) => {
  bucket.weightedRatio += ratio * weight;
  bucket.totalWeight += weight;
  bucket.sampleSize += 1;
};

const calibratedMultiplier = (averageRatio, shrink, min, max) =>
  clamp(1 + (averageRatio - 1) * shrink, min, max);

const buildLearningFactor = (multiplier, sampleSize, options = {}) => {
  const enabled = options.enabled !== false;
  const adjustmentPct = (multiplier - 1) * 100;
  const active = enabled && Math.abs(adjustmentPct) >= 1 && sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES;
  return {
    key: 'learning',
    label: 'Learning correction',
    active,
    adjustmentPct: active ? Number(adjustmentPct.toFixed(2)) : 0,
    multiplier: active ? Number(multiplier.toFixed(4)) : 1,
    effect: active
      ? `${adjustmentPct > 0 ? '+' : ''}${Number(adjustmentPct.toFixed(1))}%`
      : 'no effect',
    reason: enabled
      ? (sampleSize > 0 ? `${sampleSize} matched historical item outcomes` : 'not enough history yet')
      : (options.reason || 'Upgrade to Pro to apply learning corrections'),
  };
};

const computeForecastCalibration = async (cafeId, targetDate) => {
  const lookbackStart = new Date(targetDate);
  lookbackStart.setDate(lookbackStart.getDate() - CALIBRATION_LOOKBACK_DAYS);
  lookbackStart.setHours(0, 0, 0, 0);

  const pastForecasts = await Forecast.find({
    cafeId,
    date: { $gte: lookbackStart, $lt: targetDate },
    actualsUpdatedAt: { $exists: true, $ne: null },
  })
    .select('items')
    .lean();

  const overall = { weightedRatio: 0, totalWeight: 0, sampleSize: 0 };
  const factorBuckets = new Map();
  const itemBuckets = new Map();
  const observations = [];

  for (const forecast of pastForecasts) {
    for (const item of forecast.items || []) {
      if (item.actualQty == null || !Number.isFinite(item.predictedQty) || item.predictedQty <= 0) continue;

      const ratio = clamp(item.actualQty / item.predictedQty, 0.25, 2);
      const weight = Math.max(item.actualQty || 0, item.predictedQty || 0, 1);
      const activeFactors = (item.factors || []).filter((factor) => factor.active && factor.key !== 'learning');

      accumulateRatio(overall, ratio, weight);
      observations.push({ ratio, weight, activeFactors, itemName: item.itemName });

    }
  }

  const rawOverallRatio = overall.totalWeight > 0 ? overall.weightedRatio / overall.totalWeight : 1;
  const overallMultiplier = overall.sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES
    ? calibratedMultiplier(rawOverallRatio, 0.5, 0.85, 1.15)
    : 1;

  for (const observation of observations) {
    const residualRatio = rawOverallRatio > 0 ? observation.ratio / rawOverallRatio : observation.ratio;
    if (observation.itemName) {
      if (!itemBuckets.has(observation.itemName)) {
        itemBuckets.set(observation.itemName, { weightedRatio: 0, totalWeight: 0, sampleSize: 0 });
      }
      accumulateRatio(itemBuckets.get(observation.itemName), residualRatio, observation.weight);
    }

    for (const activeFactor of observation.activeFactors) {
      if (!factorBuckets.has(activeFactor.key)) {
        factorBuckets.set(activeFactor.key, {
          key: activeFactor.key,
          label: activeFactor.label,
          weightedRatio: 0,
          totalWeight: 0,
          sampleSize: 0,
        });
      }
      accumulateRatio(factorBuckets.get(activeFactor.key), residualRatio, observation.weight);
    }
  }

  const factorMultipliers = [...factorBuckets.values()]
    .filter((bucket) => bucket.sampleSize >= MIN_FACTOR_CALIBRATION_SAMPLES && bucket.totalWeight > 0)
    .map((bucket) => {
      const averageRatio = bucket.weightedRatio / bucket.totalWeight;
      return {
        key: bucket.key,
        label: bucket.label,
        multiplier: Number(calibratedMultiplier(averageRatio, 0.6, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        averageRatio: Number(averageRatio.toFixed(4)),
      };
    });

  const itemMultipliers = [...itemBuckets.entries()]
    .filter(([, bucket]) => bucket.sampleSize >= MIN_ITEM_CALIBRATION_SAMPLES && bucket.totalWeight > 0)
    .map(([itemName, bucket]) => {
      const averageRatio = bucket.weightedRatio / bucket.totalWeight;
      return {
        itemName,
        multiplier: Number(calibratedMultiplier(averageRatio, 0.5, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        averageRatio: Number(averageRatio.toFixed(4)),
      };
    });

  return {
    lookbackDays: CALIBRATION_LOOKBACK_DAYS,
    sampleSize: overall.sampleSize,
    overallMultiplier: Number(overallMultiplier.toFixed(4)),
    factorMultipliers,
    itemMultipliers,
    generatedAt: new Date(),
  };
};

const calibrationMultiplierForItem = (calibration, itemName, factors) => {
  let multiplier = calibration.overallMultiplier || 1;

  const itemCalibration = (calibration.itemMultipliers || []).find((entry) => entry.itemName === itemName);
  if (itemCalibration) multiplier *= itemCalibration.multiplier;

  for (const factor of factors) {
    if (!factor.active) continue;
    const factorCalibration = (calibration.factorMultipliers || []).find((entry) => entry.key === factor.key);
    if (factorCalibration) multiplier *= factorCalibration.multiplier;
  }

  return clamp(multiplier, 0.7, 1.3);
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
const buildHistoryWeights = (numWeeks, historySettings) => {
  if (numWeeks === 1) return [1.0];
  if (numWeeks === 2) return historySettings.twoWeekWeights;

  const recentWeights = historySettings.recentWeights.slice(0, 3);
  const remainingWeight = Math.max(0, 1.0 - recentWeights.reduce((sum, weight) => sum + weight, 0));
  const olderWeeks = numWeeks - recentWeights.length;
  const olderWeightPerWeek = olderWeeks > 0 ? remainingWeight / olderWeeks : 0;
  return Array.from({ length: numWeeks }, (_value, index) =>
    index < recentWeights.length ? recentWeights[index] : olderWeightPerWeek
  );
};

const weightedAverage = (buckets, historySettings) => {
  // Use the ACTUAL populated bucket indices, sorted from most recent (smallest) to oldest.
  const sortedKeys = Object.keys(buckets)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, historySettings.maxWeeks);
  const numWeeks = sortedKeys.length;
  if (numWeeks === 0) return 0;

  const weights = buildHistoryWeights(numWeeks, historySettings);

  let total = 0;
  for (let i = 0; i < numWeeks; i++) {
    const bucketKey = sortedKeys[i];
    const qty = buckets[bucketKey] || 0;
    total += qty * weights[i];
  }
  return total;
};

const buildHistoricalPriceMap = (transactions) => {
  const buckets = new Map();

  for (const tx of transactions) {
    for (const item of tx.items || []) {
      if (!item.name || !Number.isFinite(item.unitPrice) || item.unitPrice <= 0) continue;
      const qty = Number.isFinite(item.quantity) && item.quantity > 0 ? item.quantity : 1;
      if (!buckets.has(item.name)) {
        buckets.set(item.name, { value: 0, qty: 0 });
      }
      const bucket = buckets.get(item.name);
      bucket.value += item.unitPrice * qty;
      bucket.qty += qty;
    }
  }

  return new Map(
    [...buckets.entries()]
      .filter(([, bucket]) => bucket.qty > 0)
      .map(([name, bucket]) => [name, bucket.value / bucket.qty])
  );
};

/**
 * Computes a suggested stock quantity for a given item based on historical forecast bias.
 * Uses the 30 days before the target date where actualQty was recorded.
 *
 * @param {string|ObjectId} cafeId
 * @param {string} itemName
 * @param {number} predictedQty
 * @returns {Promise<number>}
 */
const computeSuggestedStock = async (cafeId, itemName, predictedQty, settings, targetDate = new Date()) => {
  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(target);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const pastForecasts = await Forecast.find({
    cafeId,
    date: { $gte: thirtyDaysAgo, $lt: target },
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

  return computeSuggestedStockFromPairs(predictedQty, pairs, settings);
};

const computeSuggestedStockFromPairs = (predictedQty, pairs, settings) => {
  const safetyMargin = 1 + settings.stock.safetyMarginPct / 100;
  const maxBias = settings.stock.maxBiasPct / 100;

  if (pairs.length >= 3) {
    const avgBias = pairs.reduce((sum, p) => {
      const bias = (p.actual - p.predicted) / Math.max(p.predicted, 1);
      return sum + Math.max(-maxBias, Math.min(maxBias, bias));
    }, 0) / pairs.length;

    const biasAdjusted = Math.round(predictedQty * (1 + avgBias) * safetyMargin);
    return Math.max(predictedQty, biasAdjusted);
  }

  // Cold start: just apply the safety margin
  return Math.round(predictedQty * safetyMargin);
};

const computeSuggestedStockMap = async (cafeId, predictedQtyByItem, settings, targetDate = new Date()) => {
  const itemNames = [...predictedQtyByItem.keys()];
  if (itemNames.length === 0) return new Map();

  const target = new Date(targetDate);
  target.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(target);
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  const pastForecasts = await Forecast.find({
    cafeId,
    date: { $gte: thirtyDaysAgo, $lt: target },
    'items.itemName': { $in: itemNames },
    'items.actualQty': { $gt: 0 },
  })
    .select('items')
    .lean();

  const itemNameSet = new Set(itemNames);
  const pairsByItem = new Map(itemNames.map((name) => [name, []]));
  for (const doc of pastForecasts) {
    for (const item of doc.items || []) {
      if (itemNameSet.has(item.itemName) && item.actualQty > 0 && item.predictedQty != null) {
        pairsByItem.get(item.itemName).push({ predicted: item.predictedQty, actual: item.actualQty });
      }
    }
  }

  return new Map(
    itemNames.map((itemName) => [
      itemName,
      computeSuggestedStockFromPairs(
        predictedQtyByItem.get(itemName),
        pairsByItem.get(itemName) || [],
        settings
      ),
    ])
  );
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
  const nextTarget = new Date(target);
  nextTarget.setDate(nextTarget.getDate() + 1);
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
  const org = cafe?.orgId ? await Organization.findById(cafe.orgId).lean() : null;
  const plan = org?.plan || 'starter';
  const settings = getForecastSettings(cafe, plan);
  const entitlements = getFactorEntitlements(plan);
  const learningEnabled = factorUnlocked(plan, 'learning') && settings.learning.enabled;
  const lat = cafe?.location?.lat || -33.9249; // Cape Town default
  const lng = cafe?.location?.lng || 18.4241;

  // Fetch signals, weather, and events in parallel
  const [signals, weather, events] = await Promise.all([
    getSignalsForDate(target, { lat, lng, city: cafe?.location?.city }),
    getWeatherForecast(lat, lng, target),
    Event.find({ cafeId, date: { $gte: target, $lt: nextTarget } }).lean(),
  ]);

  // Group transactions by week and item
  const itemWeekMap = groupByWeekAndItem(transactions, target);
  const historicalPriceMap = buildHistoricalPriceMap(transactions);

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

  const forecastFactors = buildGlobalFactors({ signals, weather, events, settings });
  const calibration = learningEnabled
    ? await computeForecastCalibration(cafeId, target)
    : {
        lookbackDays: CALIBRATION_LOOKBACK_DAYS,
        sampleSize: 0,
        overallMultiplier: 1,
        factorMultipliers: [],
        itemMultipliers: [],
        generatedAt: new Date(),
      };
  const globalLearningFactor = buildLearningFactor(
    calibration.overallMultiplier || 1,
    calibration.sampleSize || 0,
    {
      enabled: learningEnabled,
      reason: 'Learning correction is available on the Pro plan',
    }
  );
  const storedForecastFactors = [...forecastFactors, globalLearningFactor];
  const forecastItems = [];
  const predictedQtyByItem = new Map();
  let totalPredictedRevenue = 0;

  for (const name of topItems) {
    const buckets = itemWeekMap.get(name) || {};
    const baseQty = weightedAverage(buckets, settings.history);
    const category = categoryMap.get(name) || 'other';
    const factors = buildItemFactors({ category, signals, weather, events, settings });
    const learningMultiplier = learningEnabled ? calibrationMultiplierForItem(calibration, name, factors) : 1;
    const learningFactor = buildLearningFactor(
      learningMultiplier,
      calibration.sampleSize || 0,
      {
        enabled: learningEnabled,
        reason: 'Learning correction is available on the Pro plan',
      }
    );
    const storedItemFactors = [...factors, learningFactor];
    const finalQty = Math.round(baseQty * multiplyFactors(factors) * learningMultiplier);

    // Estimate revenue using item avgPrice if available
    const itemDoc = itemDocs.find((d) => d.name === name);
    const avgPrice = itemDoc?.avgPrice || historicalPriceMap.get(name) || 0;
    totalPredictedRevenue += finalQty * avgPrice;

    forecastItems.push({
      itemName: name,
      baseQty: parseFloat(baseQty.toFixed(2)),
      predictedQty: finalQty,
      factors: storedItemFactors,
    });
    predictedQtyByItem.set(name, finalQty);
  }

  const suggestedStockByItem = await computeSuggestedStockMap(cafeId, predictedQtyByItem, settings, target);
  for (const item of forecastItems) {
    item.suggestedStock = suggestedStockByItem.get(item.itemName) ?? item.predictedQty;
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
            isRain: weather.isRain,
            precipMm: weather.precipMm,
            chanceOfRain: weather.chanceOfRain,
          },
          loadSheddingStage: signals.loadSheddingStage,
          isPublicHoliday: signals.isPublicHoliday,
          isSchoolHoliday: signals.isSchoolHoliday,
          isPayday: signals.isPayday,
          dayOfWeek: targetDayOfWeek,
          events: events.map((e) => ({ name: e.name, impact: e.impact, impactPct: e.impactPct })),
        },
        factors: storedForecastFactors,
        factorSettings: settings,
        factorEntitlements: entitlements,
        calibration,
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const targetDates = Array.from({ length: 7 }, (_, i) => {
    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + i);
    return targetDate;
  });

  // Resilient: a transient failure on one day must not lose the whole week.
  const results = await Promise.allSettled(
    targetDates.map((targetDate) => generateForecast(cafeId, targetDate))
  );
  return results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
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
