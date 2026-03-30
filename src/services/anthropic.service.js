const Anthropic = require('@anthropic-ai/sdk');
const Transaction = require('../models/Transaction.model');
const Forecast = require('../models/Forecast.model');

// In-memory cache: cafeId -> { insights, generatedAt }
const insightsCache = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Generates Claude-powered sales insights for a cafe.
 *
 * @param {string|ObjectId} cafeId
 * @returns {Promise<{ insights: string[], generatedAt: Date }>}
 */
const generateInsights = async (cafeId) => {
  const cafeKey = cafeId.toString();

  // Guard: no API key
  if (!process.env.ANTHROPIC_API_KEY) {
    return {
      insights: ['AI insights require an Anthropic API key. Add ANTHROPIC_API_KEY to your environment variables.'],
      generatedAt: new Date(),
    };
  }

  // Check cache
  const cached = insightsCache.get(cafeKey);
  if (cached && Date.now() - cached.generatedAt.getTime() < CACHE_TTL_MS) {
    return { insights: cached.insights, generatedAt: cached.generatedAt };
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Fetch last 14 days of transactions
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const transactions = await Transaction.find({
    cafeId,
    status: 'approved',
    date: { $gte: fourteenDaysAgo },
  })
    .sort({ date: 1 })
    .lean();

  // Build summary stats
  const summary = buildSummaryStats(transactions);

  // Fetch tomorrow's forecast
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const tomorrowForecast = await Forecast.findOne({ cafeId, date: tomorrow }).lean();

  const prompt = `You are a data analyst for a Cape Town coffee shop. Analyse this sales data and provide 4-5 actionable insights.
Focus on: patterns, anomalies, opportunities, and staffing recommendations.
Be specific with numbers. Use South African context (weather, load shedding, holidays, etc.)

Sales summary (last 14 days):
${JSON.stringify(summary, null, 2)}

Tomorrow's forecast:
${tomorrowForecast ? JSON.stringify(tomorrowForecast, null, 2) : 'No forecast available yet.'}

Return ONLY a JSON array of insight strings. No markdown, no preamble, no explanation outside the array.
Example: ["Insight 1 here.", "Insight 2 here."]`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  });

  const content = message.content[0]?.text || '[]';

  let insights;
  try {
    // Strip any accidental markdown code fences
    const cleaned = content.replace(/```json|```/g, '').trim();
    insights = JSON.parse(cleaned);
    if (!Array.isArray(insights)) {
      insights = [content];
    }
  } catch {
    insights = [content];
  }

  const generatedAt = new Date();
  insightsCache.set(cafeKey, { insights, generatedAt });

  return { insights, generatedAt };
};

/**
 * Builds a summary statistics object from an array of transaction documents.
 */
const buildSummaryStats = (transactions) => {
  if (transactions.length === 0) {
    return { message: 'No transaction data available for the last 14 days.' };
  }

  // Daily revenue
  const dailyRevenue = {};
  const dayOfWeekRevenue = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const dayOfWeekCount = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const itemCounts = {};

  for (const tx of transactions) {
    const dateKey = new Date(tx.date).toISOString().split('T')[0];
    dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + (tx.total || 0);

    const dow = new Date(tx.date).getDay();
    dayOfWeekRevenue[dow] = (dayOfWeekRevenue[dow] || 0) + (tx.total || 0);
    dayOfWeekCount[dow] = (dayOfWeekCount[dow] || 0) + 1;

    for (const item of tx.items || []) {
      itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
    }
  }

  // Top 10 items
  const topItems = Object.entries(itemCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([name, qty]) => ({ name, qty }));

  // Day of week averages
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dowAverages = Object.entries(dayOfWeekRevenue).map(([dow, revenue]) => ({
    day: dayNames[dow],
    avgRevenue:
      dayOfWeekCount[dow] > 0
        ? parseFloat((revenue / dayOfWeekCount[dow]).toFixed(2))
        : 0,
    transactionCount: dayOfWeekCount[dow],
  }));

  const revenues = Object.values(dailyRevenue);
  const totalRevenue = revenues.reduce((s, v) => s + v, 0);
  const avgDailyRevenue = revenues.length > 0 ? totalRevenue / revenues.length : 0;

  return {
    totalTransactions: transactions.length,
    totalRevenue: parseFloat(totalRevenue.toFixed(2)),
    avgDailyRevenue: parseFloat(avgDailyRevenue.toFixed(2)),
    dailyRevenue,
    topItems,
    dayOfWeekAverages: dowAverages,
  };
};

module.exports = { generateInsights };
