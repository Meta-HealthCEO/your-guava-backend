const Anthropic = require('@anthropic-ai/sdk');
const Transaction = require('../models/Transaction.model');
const Forecast = require('../models/Forecast.model');
const Cafe = require('../models/Cafe.model');
const Event = require('../models/Event.model');
const Item = require('../models/Item.model');
const Organization = require('../models/Organization.model');
const { meterGuavaCredits } = require('./usage.service');

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

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const roundMoney = (value) => parseFloat((value || 0).toFixed(2));

const buildBusinessContext = async ({ cafeId, orgId }) => {
  const [activeCafe, organization] = await Promise.all([
    Cafe.findById(cafeId).lean(),
    orgId ? Organization.findById(orgId).lean() : null,
  ]);

  const cafes = orgId
    ? await Cafe.find({ orgId }).select('name location dataUploaded lastSyncAt yocoConnected createdAt').lean()
    : activeCafe ? [activeCafe] : [];

  const cafeIds = cafes.map((cafe) => cafe._id);
  const cafeNameById = new Map(cafes.map((cafe) => [cafe._id.toString(), cafe.name]));
  const activeCafeId = activeCafe?._id || cafeId;

  const now = new Date();
  const ninetyDaysAgo = new Date(now);
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const thirtyDaysAhead = new Date(now);
  thirtyDaysAhead.setDate(thirtyDaysAhead.getDate() + 30);
  const nextWeek = new Date(now);
  nextWeek.setDate(nextWeek.getDate() + 7);

  const baseMatch = { cafeId: { $in: cafeIds }, status: 'approved' };
  const activeCafeMatch = { cafeId: activeCafeId, status: 'approved' };

  const [
    totals,
    locationTotals,
    dailyRevenue,
    topItems,
    dayPattern,
    hourPattern,
    paymentStats,
    recentTransactions,
    menuItems,
    menuItemIssues,
    forecasts,
    upcomingEvents,
  ] = await Promise.all([
    Transaction.aggregate([
      { $match: baseMatch },
      {
        $group: {
          _id: null,
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
          firstDate: { $min: '$date' },
          lastDate: { $max: '$date' },
          avgBasket: { $avg: '$total' },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: '$cafeId',
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
      { $sort: { revenue: -1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: {
            cafeId: '$cafeId',
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          },
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { '_id.date': 1 } },
      { $limit: 120 },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          quantity: { $sum: '$items.quantity' },
          revenue: {
            $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitPrice', 0] }] },
          },
        },
      },
      { $sort: { quantity: -1 } },
      { $limit: 25 },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: '$dayOfWeek',
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...activeCafeMatch, date: { $gte: ninetyDaysAgo }, hour: { $gte: 0, $lte: 23 } } },
      {
        $group: {
          _id: '$hour',
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { ...baseMatch, date: { $gte: ninetyDaysAgo } } },
      {
        $group: {
          _id: { $ifNull: ['$paymentMethod', 'unknown'] },
          transactions: { $sum: 1 },
          revenue: { $sum: '$total' },
        },
      },
      { $sort: { transactions: -1 } },
      { $limit: 12 },
    ]),
    Transaction.find(activeCafeMatch)
      .sort({ date: -1 })
      .limit(25)
      .select('date total items paymentMethod source')
      .lean(),
    Item.find({ cafeId: { $in: cafeIds }, isActive: true })
      .sort({ totalSold: -1 })
      .limit(30)
      .select('cafeId name category avgPrice totalSold expectedPrice reviewStatus aliases priceMismatchCount lastPriceMismatchAt observedPriceMin observedPriceMax')
      .lean(),
    Item.find({
      cafeId: { $in: cafeIds },
      isActive: { $ne: false },
      $or: [
        { reviewStatus: 'needs_review' },
        { priceMismatchCount: { $gt: 0 } },
        { lastPriceMismatchAt: { $ne: null } },
      ],
    })
      .sort({ reviewStatus: -1, lastPriceMismatchAt: -1, totalSold: -1 })
      .limit(20)
      .select('cafeId name category avgPrice totalSold expectedPrice reviewStatus aliases priceMismatchCount lastPriceMismatchAt observedPriceMin observedPriceMax')
      .lean(),
    Forecast.find({ cafeId, date: { $gte: now, $lt: nextWeek } })
      .sort({ date: 1 })
      .select('date items signals totalPredictedRevenue accuracy')
      .lean(),
    Event.find({ cafeId, date: { $gte: now, $lte: thirtyDaysAhead } })
      .sort({ date: 1 })
      .limit(20)
      .lean(),
  ]);

  const total = totals[0] || {};

  return {
    organization: organization
      ? { name: organization.name, plan: organization.plan }
      : null,
    activeLocation: activeCafe
      ? {
          id: activeCafe._id,
          name: activeCafe.name,
          city: activeCafe.location?.city,
          address: activeCafe.location?.address,
          lat: activeCafe.location?.lat,
          lng: activeCafe.location?.lng,
          dataUploaded: activeCafe.dataUploaded,
          lastSyncAt: activeCafe.lastSyncAt,
        }
      : null,
    locations: cafes.map((cafe) => ({
      id: cafe._id,
      name: cafe.name,
      city: cafe.location?.city,
      address: cafe.location?.address,
      dataUploaded: cafe.dataUploaded,
      lastSyncAt: cafe.lastSyncAt,
    })),
    dataset: {
      transactionCount: total.transactions || 0,
      totalRevenue: roundMoney(total.revenue),
      avgBasket: roundMoney(total.avgBasket),
      firstDate: total.firstDate,
      lastDate: total.lastDate,
      contextWindow: 'Aggregates use the last 90 days where possible; recent transaction samples are capped at 25 rows.',
    },
    locationPerformance90d: locationTotals.map((row) => ({
      location: cafeNameById.get(row._id.toString()) || row._id,
      transactions: row.transactions,
      revenue: roundMoney(row.revenue),
    })),
    dailyRevenue90d: dailyRevenue.map((row) => ({
      location: cafeNameById.get(row._id.cafeId.toString()) || row._id.cafeId,
      date: row._id.date,
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
    })),
    topItems90d: topItems.map((item) => ({
      name: item._id,
      quantity: item.quantity,
      revenue: roundMoney(item.revenue),
    })),
    dayOfWeekPattern90d: dayPattern.map((row) => ({
      day: dayNames[row._id] || String(row._id),
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
      avgRevenuePerTransaction: row.transactions ? roundMoney(row.revenue / row.transactions) : 0,
    })),
    activeLocationHourPattern90d: hourPattern.map((row) => ({
      hour: row._id,
      revenue: roundMoney(row.revenue),
      transactions: row.transactions,
    })),
    paymentMethods90d: paymentStats.map((row) => ({
      method: row._id,
      transactions: row.transactions,
      revenue: roundMoney(row.revenue),
    })),
    menuItems: menuItems.map((item) => ({
      location: cafeNameById.get(item.cafeId.toString()) || item.cafeId,
      name: item.name,
      category: item.category,
      avgPrice: item.avgPrice,
      totalSold: item.totalSold,
      expectedPrice: item.expectedPrice,
      reviewStatus: item.reviewStatus,
      aliases: item.aliases || [],
      priceMismatchCount: item.priceMismatchCount || 0,
      lastPriceMismatchAt: item.lastPriceMismatchAt,
      observedPriceMin: item.observedPriceMin,
      observedPriceMax: item.observedPriceMax,
    })),
    menuItemIssues: menuItemIssues.map((item) => ({
      location: cafeNameById.get(item.cafeId.toString()) || item.cafeId,
      name: item.name,
      category: item.category,
      avgPrice: item.avgPrice,
      totalSold: item.totalSold,
      expectedPrice: item.expectedPrice,
      reviewStatus: item.reviewStatus,
      aliases: item.aliases || [],
      priceMismatchCount: item.priceMismatchCount || 0,
      lastPriceMismatchAt: item.lastPriceMismatchAt,
      observedPriceMin: item.observedPriceMin,
      observedPriceMax: item.observedPriceMax,
    })),
    upcomingForecasts: forecasts.map((forecast) => ({
      date: forecast.date,
      totalPredictedRevenue: forecast.totalPredictedRevenue,
      topItems: (forecast.items || [])
        .slice()
        .sort((a, b) => (b.predictedQty || 0) - (a.predictedQty || 0))
        .slice(0, 10)
        .map((item) => ({ itemName: item.itemName, predictedQty: item.predictedQty })),
      signals: forecast.signals,
      accuracy: forecast.accuracy,
    })),
    upcomingEvents: upcomingEvents.map((event) => ({
      name: event.name,
      date: event.date,
      impact: event.impact,
      notes: event.notes,
    })),
    recentTransactions: recentTransactions.map((tx) => ({
      date: tx.date,
      total: tx.total,
      paymentMethod: tx.paymentMethod,
      source: tx.source,
      items: (tx.items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    })),
  };
};

const sanitizeMessages = (messages = []) =>
  messages
    .filter((message) =>
      message &&
      ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-10)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 4000),
    }));

const missingChatKeyResponse = () => ({
  answer: 'AI chat requires an Anthropic API key. Add ANTHROPIC_API_KEY to your backend environment and restart the server.',
  generatedAt: new Date(),
  contextStats: { transactionCount: 0, locations: 0, topItems: 0, forecasts: 0, menuItemIssues: 0 },
});

const buildContextStats = (context) => ({
  transactionCount: context.dataset.transactionCount,
  locations: context.locations.length,
  topItems: context.topItems90d.length,
  forecasts: context.upcomingForecasts.length,
  menuItemIssues: context.menuItemIssues?.length || 0,
  contextWindow: context.dataset.contextWindow,
});

const buildBusinessChatRequest = async ({ cafeId, orgId, messages }) => {
  const cleanedMessages = sanitizeMessages(messages);
  if (cleanedMessages.length === 0 || cleanedMessages[cleanedMessages.length - 1].role !== 'user') {
    const err = new Error('At least one user message is required');
    err.statusCode = 400;
    throw err;
  }

  const context = await buildBusinessContext({ cafeId, orgId });
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  const system = `You are Your Guava's embedded AI business analyst for coffee shops.
Use the provided business, location, forecast, event, item, and transaction context to answer the operator's questions.
Be practical, specific, and numerate. Use South African Rand where money is discussed.
If the context does not contain enough data for a claim, say so and explain what data would be needed.
If menuItemIssues contains unresolved or price-mismatched sales items, ask the operator to confirm mapping or pricing before treating those item facts as clean.
Never invent transactions, locations, dates, or exact values not present in the context.
Prefer concise markdown with short headings, bullets, and clear next actions.

Business context:
${JSON.stringify(context, null, 2)}`;

  return {
    context,
    contextStats: buildContextStats(context),
    request: {
      model,
      max_tokens: 1400,
      temperature: 0.3,
      system,
      messages: cleanedMessages,
    },
  };
};

const generateBusinessChatResponse = async ({ cafeId, orgId, messages }) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return missingChatKeyResponse();
  }

  const { request, contextStats } = await buildBusinessChatRequest({ cafeId, orgId, messages });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const response = await client.messages.create(request);

  const answer = response.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();

  return {
    answer: answer || 'I could not generate an answer from the available data.',
    generatedAt: new Date(),
    contextStats,
  };
};

const streamBusinessChatResponse = async ({ cafeId, orgId, messages, onDelta }) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    const fallback = missingChatKeyResponse();
    onDelta(fallback.answer);
    return {
      ...fallback,
    };
  }

  const { request, contextStats } = await buildBusinessChatRequest({ cafeId, orgId, messages });
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const stream = await client.messages.create({ ...request, stream: true });
  let answer = '';

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      const text = event.delta.text || '';
      answer += text;
      onDelta(text);
    }
  }

  return {
    answer: answer || 'I could not generate an answer from the available data.',
    generatedAt: new Date(),
    contextStats,
  };
};

const crypto = require('crypto');

const mappingCache = new Map(); // sha1(headers) -> mapping

/**
 * Asks Claude Haiku to propose a column mapping for an unknown CSV format.
 *
 * @param {string[]} headers
 * @param {object[]} sampleRows up to 5 rows for context
 * @returns {Promise<{mapping: object, itemsMode: 'packed'|'line-per-row'}>}
 */
const proposeColumnMappingWithClaude = async (headers, sampleRows) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const prompt = `You are mapping CSV columns from a coffee-shop POS export to a canonical schema.

Canonical fields (target keys):
- receiptId (optional): unique transaction/receipt ID
- date (REQUIRED): transaction date
- time (optional): transaction time
- items (REQUIRED): item description column. May be packed like "1 x Flat White,2 x Muffin", or one row per line item.
- total (REQUIRED): total amount paid
- tip, discount, paymentMethod, status (optional)
- quantity (optional, only for line-per-row mode): item quantity column

Headers: ${JSON.stringify(headers)}

Sample rows:
${JSON.stringify(sampleRows.slice(0, 5), null, 2)}

Return ONLY valid JSON with this exact shape, no markdown, no preamble:
{
  "mapping": {
    "receiptId": "<source header or null>",
    "date": "<source header>",
    "time": "<source header or null>",
    "items": "<source header>",
    "total": "<source header>",
    "tip": "<source header or null>",
    "discount": "<source header or null>",
    "paymentMethod": "<source header or null>",
    "status": "<source header or null>",
    "quantity": "<source header or null>"
  },
  "itemsMode": "packed" | "line-per-row"
}

Use null for fields you cannot confidently identify. Choose itemsMode "line-per-row" if each row appears to be a single line item rather than a full receipt.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (message.content[0]?.text || '').replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(text);
  const cleaned = {};
  for (const [k, v] of Object.entries(parsed.mapping || {})) {
    if (v && headers.includes(v)) cleaned[k] = v;
  }
  return {
    mapping: cleaned,
    itemsMode: parsed.itemsMode === 'line-per-row' ? 'line-per-row' : 'packed',
  };
};

const proposeColumnMapping = async (headers, sampleRows, usageContext = {}) => {
  const cacheKey = crypto.createHash('sha1').update(headers.join('|')).digest('hex');
  if (mappingCache.has(cacheKey)) {
    return mappingCache.get(cacheKey);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return { mapping: {}, itemsMode: 'packed' };
  }

  let result = { mapping: {}, itemsMode: 'packed' };
  try {
    if (usageContext.orgId) {
      const metered = await meterGuavaCredits({
        orgId: usageContext.orgId,
        cafeId: usageContext.cafeId,
        userId: usageContext.userId,
        featureKey: 'import_column_mapping',
        metadata: { headerCount: headers.length },
        run: () => proposeColumnMappingWithClaude(headers, sampleRows),
      });
      result = { ...metered.result, guavaCredits: metered.guavaCredits };
    } else {
      result = await proposeColumnMappingWithClaude(headers, sampleRows);
    }
  } catch (err) {
    console.error('[anthropic] proposeColumnMapping failed:', err.message);
  }

  mappingCache.set(cacheKey, {
    mapping: result.mapping || {},
    itemsMode: result.itemsMode === 'line-per-row' ? 'line-per-row' : 'packed',
  });
  return result;
};

const _resetMappingCache = () => mappingCache.clear();

module.exports = {
  generateInsights,
  generateBusinessChatResponse,
  streamBusinessChatResponse,
  proposeColumnMapping,
  _resetMappingCache,
};
