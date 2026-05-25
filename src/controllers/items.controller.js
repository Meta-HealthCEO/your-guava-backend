const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const {
  normalizeItemName,
  buildAliasKeys,
  resolveMenuItem,
  findMatchCandidates,
  updateTransactionMenuItemLinks,
  rebuildItemsForCafe,
} = require('../services/menuItems.service');
const { suggestMenuItemReviews } = require('../services/menuItemReviewAi.service');

const VALID_CATEGORIES = new Set(['coffee', 'food', 'cold_drink', 'water', 'retail', 'other']);
const VALID_REVIEW_STATUSES = new Set(['matched', 'needs_review', 'ignored', 'merged']);

const numberOrUndefined = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
    payload.source = body.source || 'manual';
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

    return res.status(200).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

const reconciliation = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const items = await Item.find({
      cafeId,
      isActive: { $ne: false },
      $or: [
        { reviewStatus: 'needs_review' },
        { priceMismatchCount: { $gt: 0 } },
        { lastPriceMismatchAt: { $ne: null } },
      ],
    })
      .sort({ reviewStatus: -1, lastPriceMismatchAt: -1, totalSold: -1 })
      .lean();

    const enriched = [];
    const suggestionInputs = [];
    for (const item of items) {
      const candidates = item.reviewStatus === 'needs_review'
        ? await findMatchCandidates(cafeId, item)
        : [];
      const enrichedItem = {
        ...item,
        candidates: candidates.map((candidate) => ({
          item: candidate.item,
          score: Number(candidate.score.toFixed(2)),
        })),
      };
      enriched.push(enrichedItem);
      suggestionInputs.push({ item, candidates });
    }

    const suggestions = await suggestMenuItemReviews(cafeId, suggestionInputs, {
      orgId: req.user.orgId,
      userId: req.user.id,
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

    const item = await resolveMenuItem(req.user.cafeId, req.params.id, req.body);
    return res.status(200).json({ success: true, item });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, update, reconciliation, resolve };
