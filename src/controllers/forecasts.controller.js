const Forecast = require('../models/Forecast.model');
const {
  generateForecast,
  generateWeekForecast,
} = require('../services/forecast.service');
const {
  generateInsights,
  generateBusinessChatResponse,
  streamBusinessChatResponse,
} = require('../services/anthropic.service');
const { consumeAiCredits } = require('../services/aiUsage.service');

const needsPlanningRefresh = (forecast) => {
  if (!forecast) return true;
  return (forecast.items || []).some((item) => item.actualQty != null);
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

    const aiCredits = process.env.ANTHROPIC_API_KEY
      ? await consumeAiCredits(orgId, 1)
      : null;
    const result = await generateBusinessChatResponse({ cafeId, orgId, messages: conversation });
    return res.status(200).json({ success: true, ...result, aiCredits });
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

    const aiCredits = process.env.ANTHROPIC_API_KEY
      ? await consumeAiCredits(orgId, 1)
      : null;

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
      aiCredits,
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
  getAccuracy,
  getInsights,
  chatInsights,
  streamChatInsights,
  getRecent,
};
