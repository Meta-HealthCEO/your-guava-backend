const Item = require('../models/Item.model');
const { inferItemCategory } = require('../utils/itemCategory');
const { meterGuavaCredits } = require('./usage.service');
const { createAnthropicClient } = require('./anthropicClient.service');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const MAX_AI_REVIEW_ITEMS = 10;
const AI_REVIEW_CONCURRENCY = 2;

const roundMoney = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(2)) : undefined;
};

const suggestedPrice = (item) =>
  roundMoney(item.lastObservedPrice ?? item.avgPrice ?? item.observedPriceMax ?? item.observedPriceMin);

const looksLikeNonSaleLine = (name = '') =>
  /\b(tip|gratuity|discount|voucher|refund|rounding|round off|delivery|service fee|surcharge|cash out)\b/i.test(name);

const normaliseAiAction = (value) => {
  if (['map_to', 'confirm', 'ignore'].includes(value)) return value;
  return 'confirm';
};

const cleanSuggestion = (suggestion, item, candidates = []) => {
  const action = normaliseAiAction(suggestion?.action);
  const candidateIds = new Set(candidates.map((candidate) => String(candidate.item?._id || candidate.item?.id)));
  const targetItemId = suggestion?.targetItemId ? String(suggestion.targetItemId) : undefined;
  const validTarget = action === 'map_to' && targetItemId && candidateIds.has(targetItemId);
  const fallbackPrice = suggestedPrice(item);
  const confidence = Math.max(0, Math.min(1, Number(suggestion?.confidence) || 0.55));

  return {
    action: validTarget ? 'map_to' : action === 'map_to' ? 'confirm' : action,
    targetItemId: validTarget ? targetItemId : undefined,
    targetName: validTarget
      ? candidates.find((candidate) => String(candidate.item._id) === targetItemId)?.item.name
      : undefined,
    category: suggestion?.category || item.category || inferItemCategory(item.name),
    expectedPrice: roundMoney(suggestion?.expectedPrice) ?? fallbackPrice,
    aliases: Array.isArray(suggestion?.aliases) ? suggestion.aliases.filter(Boolean).slice(0, 5) : [item.name].filter(Boolean),
    confidence,
    reason: String(suggestion?.reason || 'Suggested from menu item and POS sales patterns.').slice(0, 240),
    source: suggestion?.source || 'rules',
    needsApproval: true,
  };
};

const fallbackSuggestion = (item, candidates = []) => {
  const price = suggestedPrice(item);
  if (looksLikeNonSaleLine(item.name)) {
    return cleanSuggestion({
      action: 'ignore',
      confidence: 0.82,
      reason: 'This looks like a payment adjustment rather than a sellable menu item.',
      source: 'rules',
    }, item, candidates);
  }

  const best = candidates[0];
  if (best && best.score >= 0.45) {
    return cleanSuggestion({
      action: 'map_to',
      targetItemId: String(best.item._id),
      confidence: Math.min(0.9, Math.max(0.58, best.score)),
      aliases: [item.name],
      reason: `The POS name is similar to existing menu item "${best.item.name}".`,
      source: 'rules',
    }, item, candidates);
  }

  if ((item.priceMismatchCount || 0) > 0 || item.lastPriceMismatchAt) {
    return cleanSuggestion({
      action: 'confirm',
      expectedPrice: price,
      confidence: 0.68,
      reason: 'The POS price differs from the saved menu price. Approve this to update the menu price to the POS value.',
      source: 'rules',
    }, item, candidates);
  }

  return cleanSuggestion({
    action: 'confirm',
    category: item.category || inferItemCategory(item.name),
    expectedPrice: price,
    confidence: 0.6,
    reason: 'No strong existing menu item match was found, so this should probably be kept as a new menu item.',
    source: 'rules',
  }, item, candidates);
};

const parseJsonObject = (text = '') => {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

const aiSuggestion = async (item, candidates = []) => {
  if (!process.env.ANTHROPIC_API_KEY || process.env.NODE_ENV === 'test') return null;

  const client = createAnthropicClient();
  const prompt = `You validate imported POS item names for a coffee shop.
Choose exactly one action:
- map_to: POS item is the same as an existing menu item
- confirm: POS item should become/keep a standalone menu item, or update its menu price
- ignore: POS line is not a sellable menu item

Return only JSON with:
{
  "action": "map_to|confirm|ignore",
  "targetItemId": "existing item id when action is map_to",
  "category": "coffee|food|cold_drink|water|retail|other",
  "expectedPrice": number or null,
  "aliases": ["POS alias"],
  "confidence": number between 0 and 1,
  "reason": "short operator-facing reason"
}

POS review item:
${JSON.stringify({
    id: item._id,
    name: item.name,
    category: item.category,
    avgPrice: item.avgPrice,
    observedPriceMin: item.observedPriceMin,
    observedPriceMax: item.observedPriceMax,
    lastObservedPrice: item.lastObservedPrice,
    totalSold: item.totalSold,
    reviewStatus: item.reviewStatus,
    priceMismatchCount: item.priceMismatchCount,
  }, null, 2)}

Existing menu item candidates:
${JSON.stringify(candidates.map((candidate) => ({
    id: candidate.item._id,
    name: candidate.item.name,
    category: candidate.item.category,
    menuPrice: candidate.item.expectedPrice,
    avgPrice: candidate.item.avgPrice,
    aliases: candidate.item.aliases || [],
    score: candidate.score,
  })), null, 2)}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 500,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  return parseJsonObject(message.content?.[0]?.text || '');
};

const suggestMenuItemReview = async (cafeId, item, candidates = [], usageContext = {}) => {
  const fallback = fallbackSuggestion(item, candidates);

  if (!usageContext.useAi || !process.env.ANTHROPIC_API_KEY || process.env.NODE_ENV === 'test') {
    return fallback;
  }

  try {
    const { result: ai } = await meterGuavaCredits({
      orgId: usageContext.orgId,
      cafeId,
      userId: usageContext.userId,
      featureKey: 'menu_item_ai_review',
      relatedEntity: { kind: 'item', id: String(item._id) },
      metadata: { itemName: item.name, candidateCount: candidates.length },
      idempotencyKey: usageContext.idempotencyPrefix
        ? `${usageContext.idempotencyPrefix}:${item._id}`
        : undefined,
      run: () => aiSuggestion(item, candidates),
    });
    if (!ai) return fallback;
    return cleanSuggestion({ ...ai, source: 'ai' }, item, candidates);
  } catch {
    return fallback;
  }
};

const mapWithConcurrency = async (values, concurrency, worker) => {
  const results = new Array(values.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker())
  );
  return results;
};

const suggestMenuItemReviews = async (cafeId, itemsWithCandidates = [], usageContext = {}) => {
  const boundedItems = usageContext.useAi
    ? itemsWithCandidates.slice(0, MAX_AI_REVIEW_ITEMS)
    : itemsWithCandidates;
  const matchedItems = await Item.find({
    cafeId,
    isActive: { $ne: false },
    reviewStatus: 'matched',
  })
    .sort({ totalSold: -1 })
    .limit(80)
    .lean();

  return mapWithConcurrency(boundedItems, AI_REVIEW_CONCURRENCY, async ({ item, candidates }) => {
    const candidateList = candidates?.length > 0
      ? candidates
      : matchedItems.slice(0, 10).map((candidate) => ({ item: candidate, score: 0 }));
    return suggestMenuItemReview(cafeId, item, candidateList, usageContext);
  });
};

module.exports = {
  MAX_AI_REVIEW_ITEMS,
  fallbackSuggestion,
  suggestMenuItemReview,
  suggestMenuItemReviews,
};
