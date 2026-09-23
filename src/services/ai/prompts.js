// What the model reads: prompt text, the fenced-JSON helper, summary stats and the label helpers. Pure, no I/O.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const { zonedDateKey, zonedDayOfWeek, zonedDayStart, getZonedDateParts } = require('../../utils/timezone');

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
// Read at call time, as every site did; BE-05-T08 replaces the body with its model config.
const modelId = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

const MAX_FORECAST_ITEMS_IN_PROMPT = 15;

const TRUNCATED_ANSWER_MARKER =
  '\n\n_This answer was cut off at the length limit. Ask a narrower follow-up to get the rest._';

/**
 * Serialises untrusted business data for a prompt fence.
 *
 * `JSON.stringify` escapes quotes and backslashes but leaves `<` and `>` alone,
 * so a value containing the literal closing tag would end the fence early and
 * everything after it would read as operator-authored instruction. Item names,
 * event notes and cafe names all come from POS imports and operator input, so
 * that is reachable. Escaping the angle brackets as JSON `\uXXXX` keeps the
 * text the model reads identical while making the delimiter unforgeable —
 * business data can no longer emit a literal `<` at all.
 */
const fencedJson = (value) =>
  JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

const missingInsightsKeyResponse = () => ({
  insights: ['AI insights require an Anthropic API key. Add ANTHROPIC_API_KEY to your environment variables.'],
  generatedAt: new Date(),
  requiresRefresh: false,
  cacheStatus: 'unconfigured',
});

const insufficientInsightDataResponse = () => ({
  insights: [
    'There are no approved sales in the last 14 days, so there is nothing to analyse yet. Upload or sync your sales and refresh again — no Guava Credits were used.',
  ],
  generatedAt: new Date(),
  requiresRefresh: true,
  cacheStatus: 'insufficient_data',
  insufficientData: true,
});

/**
 * Builds a summary statistics object from an array of transaction documents.
 */
const buildSummaryStats = (transactions, timezone = 'Africa/Johannesburg') => {
  if (transactions.length === 0) {
    return { message: 'No transaction data available for the last 14 days.' };
  }

  // Daily revenue
  const dailyRevenue = {};
  const dayOfWeekRevenue = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  const dayOfWeekCount = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  // No prototype: item names come from POS files, and "constructor" or
  // "__proto__" must count like any other name.
  const itemCounts = Object.create(null);

  for (const tx of transactions) {
    const dateKey = zonedDateKey(tx.date, timezone);
    dailyRevenue[dateKey] = (dailyRevenue[dateKey] || 0) + (tx.total || 0);

    const dow = zonedDayOfWeek(tx.date, timezone);
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
  const dailyRevenueByDow = Object.entries(dailyRevenue).reduce((acc, [date, revenue]) => {
    const dow = zonedDayOfWeek(zonedDayStart(date, timezone), timezone);
    if (!acc[dow]) acc[dow] = [];
    acc[dow].push(revenue);
    return acc;
  }, {});
  const dowAverages = Object.entries(dayOfWeekRevenue).map(([dow, revenue]) => ({
    day: dayNames[dow],
    avgRevenue:
      dailyRevenueByDow[dow]?.length > 0
        ? parseFloat((
          dailyRevenueByDow[dow].reduce((sum, value) => sum + value, 0) /
          dailyRevenueByDow[dow].length
        ).toFixed(2))
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

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const MS_PER_DAY = 86_400_000;

/**
 * Weekday for a YYYY-MM-DD key.
 *
 * Anchored at midday UTC on purpose. Forecast dates are stored at cafe-local
 * midnight, so reading a weekday off the raw instant reports the previous day
 * for any timezone ahead of UTC. Working from the key at midday cannot drift.
 */
const weekdayForKey = (dateKey) => {
  if (!dateKey) return null;
  const parsed = new Date(`${dateKey}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : dayNames[parsed.getUTCDay()];
};

/** Labels a date key against today: "today", "tomorrow", or "in 3 days". */
const relativeDayLabel = (dateKey, todayKey) => {
  if (!dateKey || !todayKey) return null;
  const from = new Date(`${todayKey}T12:00:00Z`).getTime();
  const to = new Date(`${dateKey}T12:00:00Z`).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  const days = Math.round((to - from) / MS_PER_DAY);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${Math.abs(days)} days ago`;
};

const roundMoney = (value) => parseFloat((value || 0).toFixed(2));

const zonedDateTimeLabel = (value, timezone) => {
  const parts = getZonedDateParts(value, timezone);
  if (!parts) return null;
  const pad = (entry) => String(entry).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
};

const missingChatKeyResponse = () => ({
  answer: 'AI chat requires an Anthropic API key. Add ANTHROPIC_API_KEY to your backend environment and restart the server.',
  generatedAt: new Date(),
  contextStats: { transactionCount: 0, locations: 0, topItems: 0, forecasts: 0, menuItemIssues: 0 },
});

module.exports = {
  DEFAULT_MODEL, modelId,
  MAX_FORECAST_ITEMS_IN_PROMPT, TRUNCATED_ANSWER_MARKER, fencedJson, missingInsightsKeyResponse, insufficientInsightDataResponse, buildSummaryStats,
  dayNames, weekdayForKey, relativeDayLabel, roundMoney, zonedDateTimeLabel, missingChatKeyResponse,
};
