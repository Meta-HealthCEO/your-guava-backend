const Forecast = require('../models/Forecast.model');
const {
  generateForecast,
  generateWeekForecast,
  updateForecastActuals,
} = require('../services/forecast.service');
const { generateInsights } = require('../services/anthropic.service');

const getToday = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let forecast = await Forecast.findOne({ cafeId, date: today });

    if (!forecast) {
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

    if (existing.length === 7) {
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
    })
      .sort({ date: -1 })
      .select('date accuracy totalPredictedRevenue')
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

module.exports = { getToday, getWeek, generate, getAccuracy, getInsights };
