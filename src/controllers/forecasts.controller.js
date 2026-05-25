const mongoose = require('mongoose');
const Forecast = require('../models/Forecast.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const Transaction = require('../models/Transaction.model');
const {
  generateForecast,
  generateWeekForecast,
  updateForecastActuals,
} = require('../services/forecast.service');
const {
  DEFAULT_FORECAST_SETTINGS,
  getFactorEntitlements,
  getForecastSettings,
  getSavedForecastSettings,
  normalizeForecastSettings,
} = require('../services/forecastFactors.service');
const {
  generateInsights,
  generateBusinessChatResponse,
  streamBusinessChatResponse,
} = require('../services/anthropic.service');
const { meterGuavaCredits } = require('../services/usage.service');

const REQUIRED_PLANNING_FACTOR_KEYS = ['weather', 'loadShedding', 'holiday', 'payday', 'events'];
const HISTORY_BACKFILL_BATCH_SIZE = 14;
const historyBackfillJobs = new Set();

const startOfDay = (date) => {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

const addDays = (date, days) => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const parseDateOnly = (value) => {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return startOfDay(new Date(Number(year), Number(month) - 1, Number(day)));
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed);
};

const clampHistoryDays = (value) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 90;
  return Math.max(1, Math.min(366, parsed));
};

const hasMatchedActuals = (forecast) =>
  (forecast.items || []).some((item) => item.actualQty != null) ||
  forecast.actualsUpdatedAt != null ||
  forecast.actualTransactionCount != null ||
  forecast.accuracy != null;

const hasPlanningFactorPayload = (forecast) => {
  const factors = forecast?.factors || [];
  if (!Array.isArray(factors)) return false;

  const factorKeys = new Set(factors.map((factor) => factor?.key).filter(Boolean));
  if (!REQUIRED_PLANNING_FACTOR_KEYS.every((key) => factorKeys.has(key))) return false;

  if (!forecast.factorSettings || !forecast.factorEntitlements || !forecast.calibration) return false;
  if (forecast.calibration.sampleSize == null || forecast.calibration.overallMultiplier == null) return false;

  return (forecast.items || []).every((item) => Array.isArray(item.factors) && item.factors.length > 0);
};

const needsPlanningRefresh = (forecast) => {
  if (!forecast) return true;
  if (hasMatchedActuals(forecast)) return true;
  return !hasPlanningFactorPayload(forecast);
};

const needsHistoryForecastRefresh = (forecast) => {
  if (!forecast) return true;
  if (forecast.totalPredictedRevenue == null) return true;
  return !hasPlanningFactorPayload(forecast);
};

const revenueAccuracy = (predicted, actual) => {
  if (!Number.isFinite(actual) || actual <= 0 || !Number.isFinite(predicted)) return null;
  return parseFloat(Math.max(0, (1 - Math.abs(actual - predicted) / actual) * 100).toFixed(1));
};

const buildHistoryRow = (forecast, actual = {}) => {
  const predictedRevenue = Number(forecast.totalPredictedRevenue || 0);
  const actualRevenue = Number(actual.actualRevenue ?? forecast.actualRevenue ?? 0);
  const variance = parseFloat((actualRevenue - predictedRevenue).toFixed(2));
  const variancePct =
    predictedRevenue > 0 ? parseFloat(((variance / predictedRevenue) * 100).toFixed(1)) : null;
  const activeFactors = (forecast.factors || []).filter((factor) => factor.active);

  return {
    forecastId: forecast._id,
    date: forecast.date,
    predictedRevenue,
    actualRevenue,
    variance,
    variancePct,
    revenueAccuracy: revenueAccuracy(predictedRevenue, actualRevenue),
    itemAccuracy: forecast.accuracy ?? null,
    transactionCount: actual.transactionCount ?? forecast.actualTransactionCount ?? 0,
    weather: forecast.signals?.weather || null,
    signals: {
      isPublicHoliday: Boolean(forecast.signals?.isPublicHoliday),
      isSchoolHoliday: Boolean(forecast.signals?.isSchoolHoliday),
      isPayday: Boolean(forecast.signals?.isPayday),
      loadSheddingStage: forecast.signals?.loadSheddingStage || 0,
      events: forecast.signals?.events || [],
    },
    activeFactors,
    factorSummary: activeFactors.map((factor) => ({
      key: factor.key,
      label: factor.label,
      effect: factor.effect,
      adjustmentPct: factor.adjustmentPct,
    })),
    calibration: forecast.calibration,
    trainingData: forecast.trainingData,
    generatedAt: forecast.generatedAt,
    actualsUpdatedAt: forecast.actualsUpdatedAt,
  };
};

const ensureHistoryForecast = async (cafeId, date) => {
  let forecast = await Forecast.findOne({ cafeId, date });
  if (needsHistoryForecastRefresh(forecast)) {
    forecast = await generateForecast(cafeId, date);
  }
  const updated = await updateForecastActuals(cafeId, date);
  return updated || forecast;
};

const scheduleHistoryBackfill = (cafeId, dateKeys) => {
  if (dateKeys.length === 0 || process.env.NODE_ENV === 'test') return false;

  const key = String(cafeId);
  if (historyBackfillJobs.has(key)) return false;

  const batch = dateKeys.slice(-HISTORY_BACKFILL_BATCH_SIZE).reverse();
  historyBackfillJobs.add(key);

  setImmediate(async () => {
    try {
      for (const dateKey of batch) {
        try {
          await ensureHistoryForecast(cafeId, parseDateOnly(dateKey));
        } catch (error) {
          console.error('[history] backfill failed for', dateKey, error.message);
        }
      }
    } finally {
      historyBackfillJobs.delete(key);
    }
  });

  return true;
};

const getToday = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let forecast = await Forecast.findOne({ cafeId, date: today });

    if (needsPlanningRefresh(forecast)) {
      forecast = await generateForecast(cafeId, today);
    }

    return res.status(200).json({ success: true, forecast });
  } catch (error) {
    next(error);
  }
};

const getWeek = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Check if we already have all 7 days
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);

    const existing = await Forecast.find({
      cafeId,
      date: { $gte: today, $lt: nextWeek },
    }).sort({ date: 1 });

    if (existing.length === 7 && !existing.some(needsPlanningRefresh)) {
      return res.status(200).json({ success: true, forecasts: existing });
    }

    // Generate missing forecasts
    const forecasts = await generateWeekForecast(cafeId);
    return res.status(200).json({ success: true, forecasts });
  } catch (error) {
    next(error);
  }
};

const generate = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { date } = req.body;

    if (!date) {
      return res.status(400).json({ success: false, message: 'date is required' });
    }

    const forecast = await generateForecast(cafeId, new Date(date));
    return res.status(200).json({ success: true, forecast });
  } catch (error) {
    next(error);
  }
};

const getFactors = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId).lean();
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    const org = await Organization.findById(req.user.orgId).lean();
    const plan = org?.plan || 'starter';

    return res.status(200).json({
      success: true,
      defaults: DEFAULT_FORECAST_SETTINGS,
      settings: getForecastSettings(cafe, plan),
      savedSettings: getSavedForecastSettings(cafe),
      entitlements: getFactorEntitlements(plan),
    });
  } catch (error) {
    next(error);
  }
};

const updateFactors = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId);
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });
    const org = await Organization.findById(req.user.orgId).lean();
    const plan = org?.plan || 'starter';

    const savedSettings = normalizeForecastSettings(req.body.settings || req.body || {}, getSavedForecastSettings(cafe));
    cafe.forecastSettings = savedSettings;
    await cafe.save();

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    await Forecast.deleteMany({ cafeId: cafe._id, date: { $gte: today } });

    return res.status(200).json({
      success: true,
      settings: getForecastSettings(cafe, plan),
      savedSettings,
      entitlements: getFactorEntitlements(plan),
    });
  } catch (error) {
    next(error);
  }
};

const getAccuracy = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: thirtyDaysAgo, $lt: new Date() },
      accuracy: { $exists: true, $ne: null },
      actualsUpdatedAt: { $exists: true, $ne: null },
    })
      .sort({ date: -1 })
      .select('date accuracy totalPredictedRevenue actualRevenue actualTransactionCount actualsUpdatedAt')
      .lean();

    const avgAccuracy =
      forecasts.length > 0
        ? forecasts.reduce((sum, f) => sum + f.accuracy, 0) / forecasts.length
        : null;

    return res.status(200).json({
      success: true,
      avgAccuracy: avgAccuracy !== null ? parseFloat(avgAccuracy.toFixed(1)) : null,
      forecasts,
    });
  } catch (error) {
    next(error);
  }
};

const getHistory = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = new mongoose.Types.ObjectId(String(cafeId));
    const days = clampHistoryDays(req.query.days);
    const syncBackfillLimit =
      req.query.backfill === 'sync'
        ? Math.max(1, Math.min(HISTORY_BACKFILL_BATCH_SIZE, Number.parseInt(req.query.backfillLimit, 10) || 1))
        : 0;
    const yesterday = addDays(startOfDay(new Date()), -1);
    const requestedEnd = parseDateOnly(req.query.endDate) || yesterday;
    const endDay = requestedEnd > yesterday ? yesterday : requestedEnd;
    const requestedStart = parseDateOnly(req.query.startDate);
    const startDay = requestedStart || addDays(endDay, -(days - 1));
    const endExclusive = addDays(endDay, 1);

    if (startDay > endDay) {
      return res.status(400).json({ success: false, message: 'startDate must be before endDate' });
    }

    const actuals = await Transaction.aggregate([
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: startDay, $lt: endExclusive },
        },
      },
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$date',
              timezone: 'Africa/Johannesburg',
            },
          },
          actualRevenue: { $sum: { $ifNull: ['$total', 0] } },
          transactionCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    const dateKeys = actuals.map((entry) => entry._id).slice(-366);
    const actualByDate = new Map(
      actuals.map((entry) => [
        entry._id,
        {
          actualRevenue: parseFloat(Number(entry.actualRevenue || 0).toFixed(2)),
          transactionCount: entry.transactionCount || 0,
        },
      ])
    );

    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: startDay, $lt: endExclusive },
    })
      .lean();

    const forecastByDate = new Map(forecasts.map((forecast) => [toDateKey(forecast.date), forecast]));
    let generated = 0;
    let missingDateKeys = dateKeys.filter((dateKey) => needsHistoryForecastRefresh(forecastByDate.get(dateKey)));

    if (syncBackfillLimit > 0 && missingDateKeys.length > 0) {
      const syncDates = missingDateKeys.slice(-syncBackfillLimit).reverse();

      for (const dateKey of syncDates) {
        const forecast = await ensureHistoryForecast(cafeId, parseDateOnly(dateKey));
        if (forecast) {
          forecastByDate.set(dateKey, typeof forecast.toObject === 'function' ? forecast.toObject() : forecast);
          generated += 1;
        }
      }

      missingDateKeys = dateKeys.filter((dateKey) => needsHistoryForecastRefresh(forecastByDate.get(dateKey)));
    }

    const jobStarted =
      req.query.backfill !== 'false' && req.query.backfill !== 'sync'
        ? scheduleHistoryBackfill(cafeId, missingDateKeys)
        : false;

    const rows = [];
    for (const dateKey of dateKeys) {
      const forecast = forecastByDate.get(dateKey);
      if (forecast && !needsHistoryForecastRefresh(forecast)) {
        rows.push(buildHistoryRow(forecast, actualByDate.get(dateKey)));
      }
    }

    rows.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const accuracyRows = rows.filter((row) => row.revenueAccuracy != null);
    const totalPredictedRevenue = rows.reduce((sum, row) => sum + row.predictedRevenue, 0);
    const totalActualRevenue = rows.reduce((sum, row) => sum + row.actualRevenue, 0);
    const variance = totalActualRevenue - totalPredictedRevenue;
    const overallRevenueAccuracy = revenueAccuracy(totalPredictedRevenue, totalActualRevenue);
    const avgDailyRevenueAccuracy = accuracyRows.length > 0
      ? parseFloat((accuracyRows.reduce((sum, row) => sum + row.revenueAccuracy, 0) / accuracyRows.length).toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      history: rows,
      rows,
      meta: {
        days,
        startDate: toDateKey(startDay),
        endDate: toDateKey(endDay),
        totalTradingDays: dateKeys.length,
        totalRows: rows.length,
        generated,
        pendingDays: missingDateKeys.length,
        isPartial: missingDateKeys.length > 0,
        backfill: {
          status: missingDateKeys.length === 0 ? 'complete' : jobStarted ? 'started' : 'running',
          pendingDays: missingDateKeys.length,
          batchSize: HISTORY_BACKFILL_BATCH_SIZE,
        },
        overallRevenueAccuracy,
        avgDailyRevenueAccuracy,
        avgRevenueAccuracy: avgDailyRevenueAccuracy,
        totalPredictedRevenue: parseFloat(totalPredictedRevenue.toFixed(2)),
        totalActualRevenue: parseFloat(totalActualRevenue.toFixed(2)),
        variance: parseFloat(variance.toFixed(2)),
        variancePct: totalPredictedRevenue > 0
          ? parseFloat(((variance / totalPredictedRevenue) * 100).toFixed(1))
          : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getInsights = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const result = await generateInsights(cafeId);
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

const chatInsights = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const orgId = req.user.orgId;
    const { messages, question } = req.body;

    const conversation = Array.isArray(messages)
      ? messages
      : question
        ? [{ role: 'user', content: question }]
        : [];

    if (!process.env.ANTHROPIC_API_KEY) {
      const result = await generateBusinessChatResponse({ cafeId, orgId, messages: conversation });
      return res.status(200).json({ success: true, ...result, aiCredits: null, guavaCredits: null });
    }

    const { result, guavaCredits } = await meterGuavaCredits({
      orgId,
      cafeId,
      userId: req.user.id,
      featureKey: 'ask_guava_chat',
      metadata: { messageCount: conversation.length },
      run: () => generateBusinessChatResponse({ cafeId, orgId, messages: conversation }),
    });
    return res.status(200).json({ success: true, ...result, aiCredits: guavaCredits, guavaCredits });
  } catch (error) {
    next(error);
  }
};

const writeStreamEvent = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const streamChatInsights = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const orgId = req.user.orgId;
    const { messages, question } = req.body;

    const conversation = Array.isArray(messages)
      ? messages
      : question
        ? [{ role: 'user', content: question }]
        : [];

    if (!process.env.ANTHROPIC_API_KEY) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });

      const result = await streamBusinessChatResponse({
        cafeId,
        orgId,
        messages: conversation,
        onDelta: (text) => writeStreamEvent(res, 'delta', { text }),
      });

      writeStreamEvent(res, 'done', {
        generatedAt: result.generatedAt,
        contextStats: result.contextStats,
        aiCredits: null,
        guavaCredits: null,
      });
      res.end();
      return;
    }

    const { result, guavaCredits } = await meterGuavaCredits({
      orgId,
      cafeId,
      userId: req.user.id,
      featureKey: 'ask_guava_chat',
      metadata: { messageCount: conversation.length, stream: true },
      run: () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        return streamBusinessChatResponse({
          cafeId,
          orgId,
          messages: conversation,
          onDelta: (text) => writeStreamEvent(res, 'delta', { text }),
        });
      },
    });

    writeStreamEvent(res, 'done', {
      generatedAt: result.generatedAt,
      contextStats: result.contextStats,
      aiCredits: guavaCredits,
      guavaCredits,
    });
    res.end();
  } catch (error) {
    if (res.headersSent) {
      writeStreamEvent(res, 'error', { message: error.message || 'AI chat failed' });
      return res.end();
    }
    return next(error);
  }
};

const getTomorrow = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    let forecast = await Forecast.findOne({ cafeId, date: tomorrow });

    if (needsPlanningRefresh(forecast)) {
      forecast = await generateForecast(cafeId, tomorrow);
    }

    return res.status(200).json({ success: true, forecast });
  } catch (error) {
    next(error);
  }
};

const getRecent = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: sevenDaysAgo, $lt: today },
      $or: [
        { actualsUpdatedAt: { $exists: true, $ne: null } },
        { actualTransactionCount: { $gt: 0 } },
        { accuracy: { $exists: true, $ne: null } },
      ],
    })
      .sort({ date: 1 })
      .lean();

    return res.status(200).json({ success: true, forecasts });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getToday,
  getTomorrow,
  getWeek,
  generate,
  getFactors,
  updateFactors,
  getAccuracy,
  getHistory,
  getInsights,
  chatInsights,
  streamChatInsights,
  getRecent,
};
