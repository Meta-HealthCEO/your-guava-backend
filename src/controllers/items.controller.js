const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Organization = require('../models/Organization.model');
const {
  normalizeItemName,
  buildAliasKeys,
  resolveMenuItem,
  findMatchCandidates,
  updateTransactionMenuItemLinks,
  rebuildItemsForCafe,
} = require('../services/menuItems.service');
const {
  MAX_AI_REVIEW_ITEMS,
  suggestMenuItemReviews,
} = require('../services/menuItemReviewAi.service');
const { scheduleForecastRefreshAfterMenuChange } = require('../services/forecast.service');
const { clearApiCache } = require('../middleware/cache.middleware');
const { creditSnapshot } = require('../services/usage.service');

const VALID_CATEGORIES = new Set(['coffee', 'food', 'cold_drink', 'water', 'retail', 'other']);
const VALID_REVIEW_STATUSES = new Set(['matched', 'needs_review', 'ignored', 'merged']);
const MAX_RECONCILIATION_ITEMS = 100;
const MAX_ITEM_NAME_CHARS = 200;
const MAX_ALIAS_COUNT = 50;
const MAX_ALIAS_CHARS = 200;
const MAX_NOTES_CHARS = 2000;
const MAX_EXPECTED_PRICE = 1000000;
const MAX_QUERY_CHARS = 100;

const reconciliationFilter = (cafeId) => ({
  cafeId,
  isActive: { $ne: false },
  $or: [
    { reviewStatus: 'needs_review' },
    { priceMismatchCount: { $gt: 0 } },
    { lastPriceMismatchAt: { $ne: null } },
  ],
});

const enrichReviewItems = async (cafeId, items) => {
  const enriched = [];
  const suggestionInputs = [];
  for (const item of items) {
    const candidates = item.reviewStatus === 'needs_review'
      ? await findMatchCandidates(cafeId, item)
      : [];
    enriched.push({
      ...item,
      candidates: candidates.map((candidate) => ({
        item: candidate.item,
        score: Number(candidate.score.toFixed(2)),
      })),
    });
    suggestionInputs.push({ item, candidates });
  }
  return { enriched, suggestionInputs };
};

const numberOrUndefined = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const validateItemMutation = (body = {}, { allowName = true, allowStatus = true } = {}) => {
  if (allowName && body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim().length > MAX_ITEM_NAME_CHARS) {
      return `name must be a string no longer than ${MAX_ITEM_NAME_CHARS} characters`;
    }
  }
  if (body.category !== undefined && !VALID_CATEGORIES.has(body.category)) {
    return 'category is invalid';
  }
  if (body.expectedPrice !== undefined) {
    const price = Number(body.expectedPrice);
    if (!Number.isFinite(price) || price < 0 || price > MAX_EXPECTED_PRICE) {
      return `expectedPrice must be between 0 and ${MAX_EXPECTED_PRICE}`;
    }
  }
  if (body.priceTolerancePct !== undefined) {
    const tolerance = Number(body.priceTolerancePct);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 100) {
      return 'priceTolerancePct must be between 0 and 100';
    }
  }
  if (body.aliases !== undefined) {
    if (!Array.isArray(body.aliases) || body.aliases.length > MAX_ALIAS_COUNT) {
      return `aliases must contain at most ${MAX_ALIAS_COUNT} values`;
    }
    if (body.aliases.some((alias) => typeof alias !== 'string' || alias.trim().length > MAX_ALIAS_CHARS)) {
      return `aliases must be strings no longer than ${MAX_ALIAS_CHARS} characters`;
    }
  }
  if (body.notes !== undefined &&
    (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES_CHARS)) {
    return `notes must be a string no longer than ${MAX_NOTES_CHARS} characters`;
  }
  if (allowStatus && body.reviewStatus !== undefined && !VALID_REVIEW_STATUSES.has(body.reviewStatus)) {
    return 'reviewStatus is invalid';
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean') {
    return 'isActive must be a boolean';
  }
  return null;
};

const itemPayload = (body, { creating = false } = {}) => {
  const payload = {};
  if (body.name !== undefined) {
    payload.name = String(body.name).trim();
    payload.normalizedName = normalizeItemName(payload.name);
  }
  if (body.category !== undefined && VALID_CATEGORIES.has(body.category)) payload.category = body.category;
  if (body.expectedPrice !== undefined) payload.expectedPrice = numberOrUndefined(body.expectedPrice);
  if (body.priceTolerancePct !== undefined) payload.priceTolerancePct = numberOrUndefined(body.priceTolerancePct);
  if (body.aliases !== undefined) {
    payload.aliases = Array.isArray(body.aliases)
      ? [...new Set(body.aliases.map((alias) => String(alias || '').trim()).filter(Boolean))]
      : [];
    payload.aliasKeys = buildAliasKeys(payload.aliases);
  }
  if (body.reviewStatus !== undefined && VALID_REVIEW_STATUSES.has(body.reviewStatus)) {
    payload.reviewStatus = body.reviewStatus;
  }
  if (body.isActive !== undefined) payload.isActive = Boolean(body.isActive);
  if (body.notes !== undefined) payload.notes = String(body.notes || '');

  if (creating) {
    payload.source = 'manual';
    payload.reviewStatus = payload.reviewStatus || 'matched';
    payload.isActive = payload.isActive ?? true;
    payload.aliases = payload.aliases || [];
    payload.aliasKeys = payload.aliasKeys || [];
  }

  return payload;
};

const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { q, reviewStatus, active } = req.query;
    const filter = { cafeId };

    if (q && String(q).length > MAX_QUERY_CHARS) {
      return res.status(400).json({
        success: false,
        message: `q cannot exceed ${MAX_QUERY_CHARS} characters`,
      });
    }
    if (reviewStatus && !VALID_REVIEW_STATUSES.has(reviewStatus)) {
      return res.status(400).json({ success: false, message: 'reviewStatus is invalid' });
    }
    if (active !== undefined && !['true', 'false'].includes(active)) {
      return res.status(400).json({ success: false, message: 'active must be true or false' });
    }

    if (reviewStatus) filter.reviewStatus = reviewStatus;
    if (active === 'true') filter.isActive = { $ne: false };
    if (active === 'false') filter.isActive = false;
    if (q) {
      const regex = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ name: regex }, { aliases: regex }];
    }

    const [items, counts] = await Promise.all([
      Item.find(filter)
        .sort({ reviewStatus: -1, totalSold: -1, name: 1 })
        .lean(),
      Item.aggregate([
        { $match: { cafeId: mongoose.Types.ObjectId.createFromHexString(cafeId) } },
        { $group: { _id: '$reviewStatus', count: { $sum: 1 } } },
      ]),
    ]);

    return res.status(200).json({
      success: true,
      items,
      meta: {
        counts: counts.reduce((acc, entry) => ({ ...acc, [entry._id || 'unknown']: entry.count }), {}),
      },
    });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const validationError = validateItemMutation(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const payload = itemPayload(req.body, { creating: true });
    if (!payload.name) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }

    const existing = await Item.findOne({
      cafeId: req.user.cafeId,
      normalizedName: payload.normalizedName,
    }).lean();
    if (existing) {
      return res.status(409).json({ success: false, message: 'A menu item with this name already exists' });
    }

    const item = await Item.create({
      cafeId: req.user.cafeId,
      category: 'other',
      ...payload,
    });

    return res.status(201).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const validationError = validateItemMutation(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    const item = await Item.findOne({ _id: req.params.id, cafeId: req.user.cafeId });
    if (!item) return res.status(404).json({ success: false, message: 'Item not found' });

    const payload = itemPayload(req.body);
    if (payload.name === '') {
      return res.status(400).json({ success: false, message: 'name cannot be empty' });
    }

    Object.assign(item, payload);
    await item.save();
    await updateTransactionMenuItemLinks(req.user.cafeId, item, item);
    await rebuildItemsForCafe(req.user.cafeId);
    await scheduleForecastRefreshAfterMenuChange(req.user.cafeId);
    clearApiCache();

    return res.status(200).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

const reconciliation = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 50, MAX_RECONCILIATION_ITEMS));
    const items = await Item.find(reconciliationFilter(cafeId))
      .sort({ reviewStatus: -1, lastPriceMismatchAt: -1, totalSold: -1 })
      .limit(limit)
      .lean();

    const { enriched, suggestionInputs } = await enrichReviewItems(cafeId, items);

    const suggestions = await suggestMenuItemReviews(cafeId, suggestionInputs, {
      useAi: false,
    });
    suggestions.forEach((suggestion, index) => {
      enriched[index].aiSuggestion = suggestion;
    });

    return res.status(200).json({
      success: true,
      items: enriched,
      meta: {
        needsReview: enriched.filter((item) => item.reviewStatus === 'needs_review').length,
        priceMismatches: enriched.filter((item) => item.priceMismatchCount > 0 || item.lastPriceMismatchAt).length,
        limit,
        paidAiUsed: false,
      },
    });
  } catch (error) {
    next(error);
  }
};

const generateReconciliationSuggestions = async (req, res, next) => {
  try {
    const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
    if (!idempotencyKey) {
      return res.status(400).json({
        success: false,
        message: 'Idempotency-Key is required for paid AI requests',
      });
    }
    if (idempotencyKey.length > 120) {
      return res.status(400).json({
        success: false,
        message: 'Idempotency-Key is too long',
      });
    }
    const itemIds = Array.isArray(req.body.itemIds) ? [...new Set(req.body.itemIds.map(String))] : [];
    if (itemIds.length === 0) {
      return res.status(400).json({ success: false, message: 'itemIds is required' });
    }
    if (itemIds.length > MAX_AI_REVIEW_ITEMS) {
      return res.status(400).json({
        success: false,
        message: `A maximum of ${MAX_AI_REVIEW_ITEMS} menu items can be reviewed at once`,
      });
    }
    if (itemIds.some((id) => !mongoose.isValidObjectId(id))) {
      return res.status(400).json({ success: false, message: 'itemIds contains an invalid item id' });
    }

    const cafeId = req.user.cafeId;
    const items = await Item.find({
      ...reconciliationFilter(cafeId),
      _id: { $in: itemIds },
    }).lean();
    const byId = new Map(items.map((item) => [String(item._id), item]));
    const orderedItems = itemIds.map((id) => byId.get(id)).filter(Boolean);
    if (orderedItems.length !== itemIds.length) {
      return res.status(404).json({ success: false, message: 'One or more review items were not found' });
    }

    const { enriched, suggestionInputs } = await enrichReviewItems(cafeId, orderedItems);
    const suggestions = await suggestMenuItemReviews(cafeId, suggestionInputs, {
      orgId: req.user.orgId,
      userId: req.user.id,
      useAi: true,
      idempotencyPrefix: `menu-review:${req.user.id}:${idempotencyKey}`,
    });
    suggestions.forEach((suggestion, index) => {
      const {
        guavaCredits: _credits,
        ...publicSuggestion
      } = suggestion;
      enriched[index].aiSuggestion = publicSuggestion;
    });
    const paidAiCount = suggestions.filter((suggestion) => suggestion.source === 'ai').length;
    const creditsCharged = suggestions.reduce(
      (sum, suggestion) => sum + (Number(suggestion.aiCreditsCharged) || 0),
      0
    );
    const organization = await Organization.findById(req.user.orgId);

    return res.status(200).json({
      success: true,
      items: enriched,
      guavaCredits: organization ? creditSnapshot(organization) : null,
      meta: {
        requested: itemIds.length,
        paidAiUsed: paidAiCount > 0,
        paidAiCount,
        creditsCharged,
      },
    });
  } catch (error) {
    next(error);
  }
};

const resolve = async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['confirm', 'map_to', 'ignore'].includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid resolve action' });
    }
    const validationError = validateItemMutation(req.body, { allowName: false, allowStatus: false });
    if (validationError) {
      return res.status(400).json({ success: false, message: validationError });
    }
    if (action === 'map_to' && !mongoose.isValidObjectId(req.body.targetItemId)) {
      return res.status(400).json({ success: false, message: 'targetItemId is invalid' });
    }

    const item = await resolveMenuItem(req.user.cafeId, req.params.id, req.body);
    await scheduleForecastRefreshAfterMenuChange(req.user.cafeId);
    clearApiCache();
    return res.status(200).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  create,
  generateReconciliationSuggestions,
  list,
  reconciliation,
  resolve,
  update,
};
