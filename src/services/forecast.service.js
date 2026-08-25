const Transaction = require('../models/Transaction.model');
const Item = require('../models/Item.model');
const Forecast = require('../models/Forecast.model');
const Event = require('../models/Event.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const { getSignalsForDate } = require('../utils/signals');
const { getWeatherForecast, unavailableWeatherSignal } = require('./weather.service');
const {
  safeTimezone,
  zonedDayStart,
  addZonedDays,
  zonedDateKey,
  zonedDayOrdinal,
  zonedDayOfWeek,
  processLocalCalendarDate,
} = require('./parser.service');
const {
  getForecastSettings,
  getFactorEntitlements,
  factorUnlocked,
  buildGlobalFactors,
  buildItemFactors,
  multiplyFactors,
} = require('./forecastFactors.service');
const { getCafeTradingHours, parseTime } = require('../utils/tradingHours');

const CALIBRATION_LOOKBACK_DAYS = 60;
// Sample floors for the learning correction. These were 3, which let a factor
// swing demand double digits off three observations (payday was applying -11.6%
// from n=3). A correction is only worth applying once the evidence behind it
// outweighs ordinary day-to-day variation.
const MIN_OVERALL_CALIBRATION_SAMPLES = 10;
const MIN_FACTOR_CALIBRATION_SAMPLES = 12;
const MIN_ITEM_CALIBRATION_SAMPLES = 20;
// Volume-proportional shrinkage for per-item learning corrections.
// shrink = MAX * units / (units + PRIOR): an item with PRIOR units of predicted
// history gets half of MAX, a very low-volume line gets almost none.
const ITEM_CALIBRATION_MAX_SHRINK = 0.5;
const ITEM_CALIBRATION_VOLUME_PRIOR = 300;
// How trustworthy a single item's number is, which is almost entirely a
// function of how many units it moves. Backtested error by tier on real cafe
// data: >=5/day ~25-35%, 2-5/day ~61%, <2/day ~113%. A line selling one unit
// some days and none on others cannot be forecast -- the honest thing is to
// label it rather than print a confident-looking figure next to it.
const CONFIDENCE_HIGH_MIN_QTY = 5;
const CONFIDENCE_MEDIUM_MIN_QTY = 2;

const forecastConfidence = (expectedQty) => {
  if (!Number.isFinite(expectedQty)) return 'low';
  if (expectedQty >= CONFIDENCE_HIGH_MIN_QTY) return 'high';
  if (expectedQty >= CONFIDENCE_MEDIUM_MIN_QTY) return 'medium';
  return 'low';
};

const MIN_HISTORY_WEEKS = 3;
const FORECAST_MODEL_VERSION = '2026-07-30.1';
const MAX_STORED_FORECAST_ITEMS = 25;

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const newBucket = () => ({ sumActual: 0, sumPredicted: 0, sampleSize: 0 });

// Accumulate raw quantities, not per-observation ratios. Averaging ratios
// (even weighted) inflates the result on low-volume items, because for small
// integer counts the ratio distribution is right-skewed: predicting 1 and
// selling 2 gives 2.0, while predicting 2 and selling 1 gives only 0.5.
// A ratio of sums is the unbiased estimator of systematic bias.
const accumulateTotals = (bucket, actual, predicted) => {
  bucket.sumActual += actual;
  bucket.sumPredicted += predicted;
  bucket.sampleSize += 1;
};

const bucketRatio = (bucket) =>
  (bucket.sumPredicted > 0 ? clamp(bucket.sumActual / bucket.sumPredicted, 0.25, 2) : 1);

const calibratedMultiplier = (averageRatio, shrink, min, max) =>
  clamp(1 + (averageRatio - 1) * shrink, min, max);

const buildLearningFactor = (multiplier, sampleSize, options = {}) => {
  const enabled = options.enabled !== false;
  const measuredPct = (multiplier - 1) * 100;
  const hasEvidence = enabled && sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES;
  // Applied only when the correction is switched on AND large enough to matter.
  const applied = hasEvidence && Math.abs(measuredPct) >= 1;

  const formattedBias = `${measuredPct > 0 ? '+' : ''}${Number(measuredPct.toFixed(1))}%`;
  let effect;
  if (applied) effect = formattedBias;
  else if (hasEvidence && Math.abs(measuredPct) >= 1) effect = `${formattedBias} measured, not applied`;
  else effect = 'no effect';

  let reason;
  if (!enabled) {
    reason = options.reason || 'Upgrade to Pro to apply learning corrections';
  } else if (!hasEvidence) {
    reason = sampleSize > 0
      ? `${sampleSize} matched days so far; ${MIN_OVERALL_CALIBRATION_SAMPLES} needed`
      : 'not enough history yet';
  } else if (!applied) {
    reason = `Tracking a ${formattedBias} bias over ${sampleSize} days — too small to act on.`;
  } else {
    reason = `${sampleSize} matched historical item outcomes`;
  }

  return {
    key: 'learning',
    label: 'Learning correction',
    active: applied,
    measuredPct: hasEvidence ? Number(measuredPct.toFixed(2)) : 0,
    sampleSize,
    adjustmentPct: applied ? Number(measuredPct.toFixed(2)) : 0,
    multiplier: applied ? Number(multiplier.toFixed(4)) : 1,
    effect,
    reason,
  };
};

const computeForecastCalibration = async (cafeId, targetDate, timezone) => {
  const lookbackStart = addZonedDays(targetDate, -CALIBRATION_LOOKBACK_DAYS, timezone);

  const pastForecasts = await Forecast.find({
    cafeId,
    date: { $gte: lookbackStart, $lt: targetDate },
    actualsUpdatedAt: { $exists: true, $ne: null },
    origin: { $ne: 'backfill' },
    'availability.status': { $ne: 'insufficient_data' },
  })
    .select('date items')
    .lean();

  const overall = newBucket();
  const factorBuckets = new Map();
  const itemBuckets = new Map();
  const dailyObservations = [];
  const itemObservations = [];

  for (const forecast of pastForecasts) {
    let dailyPredicted = 0;
    let dailyActual = 0;
    let hasActual = false;
    const dailyFactors = new Map();

    for (const item of forecast.items || []) {
      if (item.actualQty == null || !Number.isFinite(item.predictedQty) || item.predictedQty <= 0) continue;

      const activeFactors = (item.factors || []).filter((factor) => factor.active && factor.key !== 'learning');

      dailyPredicted += item.predictedQty;
      dailyActual += item.actualQty;
      hasActual = true;
      itemObservations.push({
        actual: item.actualQty,
        predicted: item.predictedQty,
        itemName: item.itemName,
      });
      for (const activeFactor of activeFactors) {
        if (!dailyFactors.has(activeFactor.key)) dailyFactors.set(activeFactor.key, activeFactor);
      }
    }

    if (hasActual && dailyPredicted > 0) {
      accumulateTotals(overall, dailyActual, dailyPredicted);
      dailyObservations.push({
        actual: dailyActual,
        predicted: dailyPredicted,
        activeFactors: [...dailyFactors.values()],
      });
    }
  }

  const rawOverallRatio = bucketRatio(overall);
  const overallMultiplier = overall.sampleSize >= MIN_OVERALL_CALIBRATION_SAMPLES
    ? calibratedMultiplier(rawOverallRatio, 0.5, 0.85, 1.15)
    : 1;

  // Residual = how much this slice deviates AFTER the overall bias is removed,
  // so the overall correction is not counted twice when the two are multiplied.
  const residualise = (ratio) =>
    (rawOverallRatio > 0 ? clamp(ratio / rawOverallRatio, 0.25, 2) : ratio);

  for (const observation of itemObservations) {
    if (!observation.itemName) continue;
    if (!itemBuckets.has(observation.itemName)) {
      itemBuckets.set(observation.itemName, newBucket());
    }
    accumulateTotals(itemBuckets.get(observation.itemName), observation.actual, observation.predicted);
  }

  // A factor receives at most one observation per trading day. Counting every
  // item as a separate sample would create false confidence from one outcome.
  for (const observation of dailyObservations) {
    for (const activeFactor of observation.activeFactors) {
      if (!factorBuckets.has(activeFactor.key)) {
        factorBuckets.set(activeFactor.key, {
          key: activeFactor.key,
          label: activeFactor.label,
          ...newBucket(),
        });
      }
      accumulateTotals(factorBuckets.get(activeFactor.key), observation.actual, observation.predicted);
    }
  }

  const factorMultipliers = [...factorBuckets.values()]
    .filter((bucket) => bucket.sampleSize >= MIN_FACTOR_CALIBRATION_SAMPLES && bucket.sumPredicted > 0)
    .map((bucket) => {
      const averageRatio = residualise(bucketRatio(bucket));
      return {
        key: bucket.key,
        label: bucket.label,
        multiplier: Number(calibratedMultiplier(averageRatio, 0.6, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        averageRatio: Number(averageRatio.toFixed(4)),
      };
    });

  const itemMultipliers = [...itemBuckets.entries()]
    .filter(([, bucket]) => bucket.sampleSize >= MIN_ITEM_CALIBRATION_SAMPLES && bucket.sumPredicted > 0)
    .map(([itemName, bucket]) => {
      const averageRatio = residualise(bucketRatio(bucket));
      // Trust an item's own correction in proportion to the volume behind it.
      // A line selling ~1/day produces a ratio that is mostly noise, so pulling
      // it hard toward 1 avoids importing that noise into tomorrow's forecast.
      const shrink = ITEM_CALIBRATION_MAX_SHRINK
        * (bucket.sumPredicted / (bucket.sumPredicted + ITEM_CALIBRATION_VOLUME_PRIOR));
      return {
        itemName,
        multiplier: Number(calibratedMultiplier(averageRatio, shrink, 0.8, 1.2).toFixed(4)),
        sampleSize: bucket.sampleSize,
        observedUnits: bucket.sumActual,
        shrink: Number(shrink.toFixed(3)),
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

  // Active factors on one day are confounded. Apply only the strongest learned
  // residual instead of multiplying several corrections learned from the same
  // underlying outcome.
  const factorCalibration = factors
    .filter((factor) => factor.active)
    .map((factor) => (calibration.factorMultipliers || []).find((entry) => entry.key === factor.key))
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.multiplier - 1) - Math.abs(a.multiplier - 1))[0];
  if (factorCalibration) multiplier *= factorCalibration.multiplier;

  return clamp(multiplier, 0.7, 1.3);
};

/**
 * Groups transactions by week bucket (most recent = bucket 0) and by item name.
 * Returns: Map<itemName, number[]> where each number is the quantity sold that week.
 */
const groupByWeekAndItem = (transactions, targetDate, timezone, maxWeeks) => {
  const targetOrdinal = zonedDayOrdinal(targetDate, timezone);

  // Bucket index: 0 = this week, 1 = last week, etc.
  const getBucket = (txDate) => {
    const diffDays = targetOrdinal - zonedDayOrdinal(txDate, timezone);
    if (diffDays <= 0) return -1;
    return Math.floor((diffDays - 1) / 7);
  };

  const itemWeekMap = new Map();
  const observedBuckets = new Set();

  for (const tx of transactions) {
    if (!tx.items || tx.items.length === 0) continue;
    const bucket = getBucket(tx.date);
    if (bucket < 0 || bucket >= maxWeeks) continue;
    observedBuckets.add(bucket);
    for (const item of tx.items) {
      if (!item.name) continue;
      if (!itemWeekMap.has(item.name)) {
        itemWeekMap.set(item.name, Array(maxWeeks).fill(null));
      }
      const buckets = itemWeekMap.get(item.name);
      buckets[bucket] = (buckets[bucket] || 0) + item.quantity;
    }
  }

  // An observed trading day with no sale for an item is a real zero. A bucket
  // with no transactions at all remains null (missing data), not zero.
  for (const buckets of itemWeekMap.values()) {
    for (const bucket of observedBuckets) {
      if (buckets[bucket] == null) buckets[bucket] = 0;
    }
  }

  return { itemWeekMap, observedBuckets };
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
  if (numWeeks === 2) {
    const weights = historySettings.twoWeekWeights;
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    return weights.map((weight) => weight / total);
  }

  const recentWeights = historySettings.recentWeights.slice(0, 3);
  const remainingWeight = Math.max(0, 1.0 - recentWeights.reduce((sum, weight) => sum + weight, 0));
  const olderWeeks = numWeeks - recentWeights.length;
  const olderWeightPerWeek = olderWeeks > 0 ? remainingWeight / olderWeeks : 0;
  const weights = Array.from({ length: numWeeks }, (_value, index) =>
    index < recentWeights.length ? recentWeights[index] : olderWeightPerWeek
  );
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  return total > 0 ? weights.map((weight) => weight / total) : Array(numWeeks).fill(1 / numWeeks);
};

const weightedAverage = (buckets, historySettings) => {
  const window = Array.isArray(buckets)
    ? buckets.slice(0, historySettings.maxWeeks)
    : Array.from({ length: historySettings.maxWeeks }, (_, index) => buckets[index] ?? null);
  const weights = buildHistoryWeights(window.length, historySettings);
  let weightedTotal = 0;
  let observedWeight = 0;
  window.forEach((qty, index) => {
    if (qty == null) return;
    weightedTotal += qty * weights[index];
    observedWeight += weights[index];
  });
  if (observedWeight <= 0) return 0;
  // Normalising the weights accumulates floating-point error -- 0.35 + 0.25 +
  // 0.20 is 0.7999... in binary -- which can leave a value a hair below an exact
  // .5 and cost a whole unit at Math.round. Settling it well below any
  // meaningful quantity keeps the displayed base and the prediction agreeing.
  return Number((weightedTotal / observedWeight).toFixed(6));
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
const computeSuggestedStock = async (
  cafeId,
  itemName,
  predictedQty,
  settings,
  targetDate = new Date(),
  timezone = 'Africa/Johannesburg'
) => {
  const target = zonedDayStart(targetDate, timezone);
  const thirtyDaysAgo = addZonedDays(target, -30, timezone);

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

const computeSuggestedStockMap = async (
  cafeId,
  predictedQtyByItem,
  settings,
  targetDate = new Date(),
  timezone = 'Africa/Johannesburg'
) => {
  const itemNames = [...predictedQtyByItem.keys()];
  if (itemNames.length === 0) return new Map();

  const target = zonedDayStart(targetDate, timezone);
  const thirtyDaysAgo = addZonedDays(target, -30, timezone);

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

const getTradingAvailability = (cafe, events, dayOfWeek) => {
  const schedule = getCafeTradingHours(cafe).find((entry) => entry.dayOfWeek === dayOfWeek);
  if (!schedule?.isOpen) {
    return { status: 'closed', multiplier: 0, reason: 'Cafe is closed in its trading hours' };
  }

  const fullClosure = (events || []).find((event) => event.type === 'closure');
  if (fullClosure) {
    return { status: 'closed', multiplier: 0, reason: fullClosure.name || 'Cafe closure' };
  }

  const openMinutes = parseTime(schedule.openTime);
  const closeMinutes = parseTime(schedule.closeTime);
  const scheduledMinutes = closeMinutes != null && openMinutes != null ? closeMinutes - openMinutes : 0;
  if (scheduledMinutes <= 0) {
    return { status: 'closed', multiplier: 0, reason: 'Cafe has no valid trading window' };
  }

  const closureIntervals = (events || [])
    .filter((entry) => entry.type === 'partial_closure')
    .map((event) => {
      const start = parseTime(event.closureWindow?.startTime);
      const end = parseTime(event.closureWindow?.endTime);
      if (start == null || end == null || end <= start) return null;
      const clippedStart = Math.max(openMinutes, start);
      const clippedEnd = Math.min(closeMinutes, end);
      return clippedEnd > clippedStart ? [clippedStart, clippedEnd] : null;
    })
    .filter(Boolean)
    .sort((left, right) => left[0] - right[0]);

  let closedMinutes = 0;
  let activeInterval = null;
  for (const interval of closureIntervals) {
    if (!activeInterval) {
      activeInterval = interval;
      continue;
    }
    if (interval[0] <= activeInterval[1]) {
      activeInterval[1] = Math.max(activeInterval[1], interval[1]);
      continue;
    }
    closedMinutes += activeInterval[1] - activeInterval[0];
    activeInterval = interval;
  }
  if (activeInterval) closedMinutes += activeInterval[1] - activeInterval[0];

  const multiplier = clamp(1 - Math.min(scheduledMinutes, closedMinutes) / scheduledMinutes, 0, 1);
  if (multiplier < 1) {
    return {
      status: multiplier === 0 ? 'closed' : 'ready',
      multiplier,
      reason: multiplier === 0 ? 'Partial closures cover the full trading day' : 'Reduced trading hours',
    };
  }
  return { status: 'ready', multiplier: 1, reason: '' };
};

/**
 * Generates a sales forecast for a cafe on a specific target date.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} targetDate
 * @returns {Promise<Forecast>}
 */
const generateForecast = async (cafeId, targetDate, options = {}) => {
  const cafe = await Cafe.findById(cafeId).lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const timezone = safeTimezone(cafe.timezone);
  const target = zonedDayStart(targetDate, timezone);
  if (!target) {
    const error = new Error('Invalid forecast date');
    error.statusCode = 400;
    throw error;
  }
  const nextTarget = addZonedDays(target, 1, timezone);
  const targetDayOfWeek = zonedDayOfWeek(target, timezone);

  // Fetch last 8 weeks of same-day-of-week transactions
  const eightWeeksAgo = addZonedDays(target, -56, timezone);

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
  const staleDays =
    lastTransactionDate != null
      ? Math.max(0, zonedDayOrdinal(target, timezone) - zonedDayOrdinal(lastTransactionDate, timezone))
      : undefined;

  // Get cafe location for weather
  const org = cafe?.orgId ? await Organization.findById(cafe.orgId).lean() : null;
  const plan = org?.plan || 'starter';
  const settings = getForecastSettings(cafe, plan);
  const entitlements = getFactorEntitlements(plan);
  const learningEnabled = factorUnlocked(plan, 'learning') && settings.learning.enabled;
  const lat = cafe.location?.lat;
  const lng = cafe.location?.lng;
  const hasCoordinates = Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const localCalendarDate = processLocalCalendarDate(target, timezone);

  // Fetch signals, weather, and events in parallel
  const [signals, weather, events] = await Promise.all([
    getSignalsForDate(localCalendarDate, { city: cafe.location?.city }),
    hasCoordinates ? getWeatherForecast(lat, lng, localCalendarDate) : Promise.resolve(null),
    Event.find({ cafeId, date: { $gte: target, $lt: nextTarget } }).lean(),
  ]);
  const weatherSignal = weather || unavailableWeatherSignal('Cafe coordinates are not configured');
  const trading = getTradingAvailability(cafe, events, targetDayOfWeek);

  // Group transactions by week and item
  const { itemWeekMap, observedBuckets } = groupByWeekAndItem(
    transactions,
    target,
    timezone,
    settings.history.maxWeeks
  );
  const observedWeeks = observedBuckets.size;
  const missingWeeks = Math.max(0, settings.history.maxWeeks - observedWeeks);
  const historicalPriceMap = buildHistoricalPriceMap(transactions);

  // Forecast every observed item so revenue and accuracy include the long tail.
  // The portal limits visual lists, but the model must not silently omit sales.
  const itemTotals = [];
  for (const [name, buckets] of itemWeekMap.entries()) {
    const total = Object.values(buckets).reduce((s, v) => s + v, 0);
    itemTotals.push({ name, total });
  }
  itemTotals.sort((a, b) => b.total - a.total);
  const forecastItemNames = itemTotals.map((i) => i.name);

  // Fetch item categories
  const itemDocs = await Item.find({ cafeId, name: { $in: forecastItemNames } }).lean();
  const categoryMap = new Map(itemDocs.map((i) => [i.name, i.category]));
  const itemDocMap = new Map(itemDocs.map((item) => [item.name, item]));

  const forecastFactors = buildGlobalFactors({ signals, weather: weatherSignal, events, settings });
  const tradingFactor = {
    key: 'tradingHours',
    label: 'Trading hours',
    active: trading.multiplier !== 1,
    adjustmentPct: Number(((trading.multiplier - 1) * 100).toFixed(2)),
    multiplier: trading.multiplier,
    effect: trading.multiplier === 1
      ? 'no effect'
      : `${Number(((trading.multiplier - 1) * 100).toFixed(1))}%`,
    reason: trading.reason,
  };
  const calibration = learningEnabled
    ? await computeForecastCalibration(cafeId, target, timezone)
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
  const storedForecastFactors = [...forecastFactors, tradingFactor, globalLearningFactor];
  const forecastItems = [];
  const predictedQtyByItem = new Map();
  let totalPredictedRevenue = 0;
  let totalPredictedQty = 0;

  for (const [itemIndex, name] of forecastItemNames.entries()) {
    const buckets = itemWeekMap.get(name) || Array(settings.history.maxWeeks).fill(null);
    const baseQty = weightedAverage(buckets, settings.history);
    const category = categoryMap.get(name) || 'other';
    const factors = buildItemFactors({ category, signals, weather: weatherSignal, events, settings });
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
    const finalQty = Math.max(
      0,
      Math.round(baseQty * multiplyFactors(factors) * learningMultiplier * trading.multiplier)
    );

    // Estimate revenue using item avgPrice if available
    const itemDoc = itemDocMap.get(name);
    const avgPrice = itemDoc?.avgPrice || historicalPriceMap.get(name) || 0;
    totalPredictedRevenue += finalQty * avgPrice;
    totalPredictedQty += finalQty;

    if (itemIndex < MAX_STORED_FORECAST_ITEMS) {
      forecastItems.push({
        itemName: name,
        baseQty: parseFloat(baseQty.toFixed(2)),
        predictedQty: finalQty,
        confidence: forecastConfidence(baseQty),
        factors: storedItemFactors,
      });
      predictedQtyByItem.set(name, finalQty);
    }
  }

  const suggestedStockByItem = await computeSuggestedStockMap(
    cafeId,
    predictedQtyByItem,
    settings,
    target,
    timezone
  );
  for (const item of forecastItems) {
    item.suggestedStock = suggestedStockByItem.get(item.itemName) ?? item.predictedQty;
  }

  // Upsert forecast document
  const existingForecast = await Forecast.findOne({
    cafeId,
    date: { $gte: target, $lt: nextTarget },
  }).select('_id').lean();
  const dateKey = zonedDateKey(target, timezone);
  const origin = ['live', 'backfill', 'manual'].includes(options.origin)
    ? options.origin
    : 'live';
  const availabilityStatus = trading.status === 'closed'
    ? 'closed'
    : observedWeeks < MIN_HISTORY_WEEKS
      ? 'insufficient_data'
      : 'ready';
  // Configuration is never checked against reality anywhere else, and the two
  // can disagree silently: a weekday marked closed still forecasts zero even
  // when months of sales exist for it. That mis-set Sunday cost ~9 points of
  // aggregate accuracy before anyone noticed, because a zero forecast on a
  // trading day looks like a quiet day rather than a broken setting.
  // `transactions` is already the matching-weekday window, so this is free.
  const contradictsHistory =
    availabilityStatus === 'closed' && observedWeeks > 0 && transactions.length > 0;
  const availabilityReason = availabilityStatus === 'closed'
    ? (contradictsHistory
      ? `${trading.reason}, but ${transactions.length} sales were recorded on this weekday in the last ${settings.history.maxWeeks} weeks. Check the trading hours in Settings — this day is forecasting zero.`
      : trading.reason)
    : availabilityStatus === 'insufficient_data'
      ? `At least ${MIN_HISTORY_WEEKS} observed matching trading days are required; ${observedWeeks} available`
      : '';
  const forecast = await Forecast.findOneAndUpdate(
    existingForecast ? { _id: existingForecast._id } : { cafeId, date: target },
    {
      $set: {
        cafeId,
        date: target,
        dateKey,
        generatedAt: new Date(),
        origin,
        modelVersion: FORECAST_MODEL_VERSION,
        trainingCutoff: target,
        availability: {
          status: availabilityStatus,
          reason: availabilityReason,
          contradictsHistory,
        },
        items: forecastItems,
        signals: {
          weather: {
            available: weatherSignal.available,
            temp: weatherSignal.temp,
            condition: weatherSignal.condition,
            humidity: weatherSignal.humidity,
            isRain: weatherSignal.isRain,
            precipMm: weatherSignal.precipMm,
            chanceOfRain: weatherSignal.chanceOfRain,
            unavailableReason: weatherSignal.unavailableReason,
          },
          loadSheddingStage: signals.loadSheddingStage,
          loadSheddingAvailable: signals.loadSheddingAvailable,
          loadSheddingUnavailableReason: signals.loadSheddingUnavailableReason,
          isPublicHoliday: signals.isPublicHoliday,
          isSchoolHoliday: signals.isSchoolHoliday,
          isPayday: signals.isPayday,
          dayOfWeek: targetDayOfWeek,
          events: events.map((e) => ({
            name: e.name,
            type: e.type,
            impact: e.impact,
            impactPct: e.impactPct,
            closureWindow: e.closureWindow,
          })),
        },
        factors: storedForecastFactors,
        factorSettings: settings,
        factorEntitlements: entitlements,
        calibration,
        totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
        forecastCoverage: {
          itemCount: forecastItemNames.length,
          storedItemCount: forecastItems.length,
          totalPredictedQty,
          includesAllRevenue: true,
          accuracyMethod: 'aggregate_quantity',
        },
        trainingData: {
          transactionCount: transactions.length,
          firstTransactionDate,
          lastTransactionDate,
          weeksWithSales: observedWeeks,
          observedWeeks,
          missingWeeks,
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
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  if (!cafe) {
    const error = new Error('Cafe not found');
    error.statusCode = 404;
    throw error;
  }
  const timezone = safeTimezone(cafe.timezone);
  const today = zonedDayStart(new Date(), timezone);

  const targetDates = Array.from(
    { length: 7 },
    (_, index) => addZonedDays(today, index, timezone)
  );

  // Resilient: a transient failure on one day must not lose the whole week.
  const results = await Promise.allSettled(
    targetDates.map((targetDate) => generateForecast(cafeId, targetDate, { origin: 'live' }))
  );
  return results
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value);
};

/**
 * Pulls actual transactions for a given date and updates forecast accuracy.
 * Accuracy is the bounded relative error between total predicted and sold units.
 *
 * @param {string|ObjectId} cafeId
 * @param {Date|string} date
 * @returns {Promise<Forecast|null>}
 */
const updateForecastActuals = async (cafeId, date, options = {}) => {
  let timezone = options.timezone;
  if (!timezone) {
    const cafe = await Cafe.findById(cafeId).select('timezone').lean();
    timezone = cafe?.timezone;
  }
  timezone = safeTimezone(timezone);
  const target = zonedDayStart(date, timezone);
  if (!target) {
    const error = new Error('Invalid forecast date');
    error.statusCode = 400;
    throw error;
  }
  const nextDay = addZonedDays(target, 1, timezone);

  const forecast = await Forecast.findOne({
    cafeId,
    date: { $gte: target, $lt: nextDay },
  }).sort({ date: 1 });
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

  // Update actualQty on each displayed forecast item. Overall accuracy uses
  // aggregate quantity across every predicted and sold item, including the
  // long tail that is intentionally omitted from the bounded detail payload.
  let totalActual = 0;

  for (const fi of forecast.items) {
    fi.actualQty = actualMap.get(fi.itemName) || 0;
  }

  for (const actualQty of actualMap.values()) totalActual += actualQty;
  const hasCompleteCoverage = forecast.forecastCoverage?.includesAllRevenue === true &&
    Number.isFinite(forecast.forecastCoverage?.totalPredictedQty);
  const totalPredicted = hasCompleteCoverage
    ? forecast.forecastCoverage.totalPredictedQty
    : forecast.items.reduce((sum, item) => sum + (Number(item.predictedQty) || 0), 0);
  const totalAbsError = Math.abs(totalPredicted - totalActual);

  // Aggregate relative accuracy, clamped between 0 and 100.
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

const refreshHistoricalActualsAfterMenuChange = async (cafeId, timezone) => {
  const today = zonedDayStart(new Date(), timezone);
  const historical = await Forecast.find({
    cafeId,
    date: { $lt: today },
    actualsUpdatedAt: { $exists: true, $ne: null },
  })
    .select('date')
    .sort({ date: -1 })
    .limit(366)
    .lean();
  for (const forecast of historical) {
    await updateForecastActuals(cafeId, forecast.date, { timezone });
  }
};

const invalidateFutureForecastsAfterMenuChange = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  if (!cafe) return null;
  const timezone = safeTimezone(cafe.timezone);
  const today = zonedDayStart(new Date(), timezone);
  await Forecast.deleteMany({ cafeId, date: { $gte: today } });
  return timezone;
};

const refreshForecastsAfterMenuChange = async (cafeId) => {
  const timezone = await invalidateFutureForecastsAfterMenuChange(cafeId);
  if (!timezone) return;
  await refreshHistoricalActualsAfterMenuChange(cafeId, timezone);
};

const scheduleForecastRefreshAfterMenuChange = async (cafeId) => {
  // Future plans are invalidated before the mutation response is returned.
  // Historical actual recomputation is bounded and may finish asynchronously.
  const timezone = await invalidateFutureForecastsAfterMenuChange(cafeId);
  if (!timezone) return;
  if (process.env.NODE_ENV === 'test') {
    await refreshHistoricalActualsAfterMenuChange(cafeId, timezone);
    return;
  }
  setImmediate(() => {
    refreshHistoricalActualsAfterMenuChange(cafeId, timezone).catch((error) => {
      console.error('[forecasts] menu-change refresh failed:', error.message);
    });
  });
};

module.exports = {
  FORECAST_MODEL_VERSION,
  MIN_HISTORY_WEEKS,
  MAX_STORED_FORECAST_ITEMS,
  generateForecast,
  generateWeekForecast,
  updateForecastActuals,
  refreshForecastsAfterMenuChange,
  scheduleForecastRefreshAfterMenuChange,
  _test: {
    buildHistoryWeights,
    groupByWeekAndItem,
    weightedAverage,
    getTradingAvailability,
  },
};
