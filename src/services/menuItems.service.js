const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Transaction = require('../models/Transaction.model');
const { inferItemCategory } = require('../utils/itemCategory');

const normalizeItemName = (name = '') =>
  String(name)
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const toObjectId = (id) => (
  id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
);

const uniqueStrings = (values = []) =>
  [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];

const buildAliasKeys = (aliases = []) =>
  uniqueStrings(aliases).map(normalizeItemName).filter(Boolean);

const levenshteinDistance = (a = '', b = '') => {
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
    }
  }
  return rows[a.length][b.length];
};

const stringSimilarity = (a = '', b = '') => {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return 1 - (levenshteinDistance(a, b) / longest);
};

const ensureMenuItem = async (cafeId, rawName, item = {}) => {
  const name = String(rawName || '').trim() || 'Unknown Item';
  const normalizedName = normalizeItemName(name);
  const existing = await Item.findOne({
    cafeId,
    $or: [
      { name },
      { normalizedName },
      { aliasKeys: normalizedName },
    ],
  });

  if (existing) return existing;

  const unitPrice = Number.isFinite(Number(item.unitPrice)) ? Number(item.unitPrice) : undefined;
  return Item.create({
    cafeId,
    name,
    normalizedName,
    category: inferItemCategory(name),
    expectedPrice: unitPrice,
    source: 'imported',
    reviewStatus: 'needs_review',
    aliases: [],
    aliasKeys: [],
    avgPrice: unitPrice,
    observedPriceMin: unitPrice,
    observedPriceMax: unitPrice,
    lastObservedPrice: unitPrice,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  });
};

const priceCheckForItem = (menuItem, unitPrice) => {
  const expectedPrice = Number(menuItem.expectedPrice);
  const observedPrice = Number(unitPrice);
  if (!Number.isFinite(expectedPrice) || expectedPrice <= 0 || !Number.isFinite(observedPrice)) {
    return { expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : undefined };
  }

  const priceVariancePct = Number((((observedPrice - expectedPrice) / expectedPrice) * 100).toFixed(2));
  const tolerance = Number.isFinite(Number(menuItem.priceTolerancePct))
    ? Number(menuItem.priceTolerancePct)
    : 10;
  const isMismatch = Math.abs(priceVariancePct) > tolerance;

  return { expectedPrice, priceVariancePct, isMismatch };
};

const reconcileTransactionItems = async (cafeId, items = []) => {
  const reconciled = [];
  const mismatchUpdates = new Map();

  for (const item of items) {
    const rawName = String(item.name || '').trim();
    const menuItem = await ensureMenuItem(cafeId, rawName, item);
    const priceCheck = priceCheckForItem(menuItem, item.unitPrice);
    const menuItemStatus = priceCheck.isMismatch
      ? 'price_mismatch'
      : menuItem.reviewStatus === 'needs_review'
        ? 'needs_review'
        : menuItem.reviewStatus === 'ignored'
          ? 'ignored'
          : 'matched';

    if (priceCheck.isMismatch) {
      mismatchUpdates.set(String(menuItem._id), menuItem);
    }

    reconciled.push({
      ...item,
      salesItemId: menuItem._id,
      rawName: rawName !== menuItem.name ? rawName : item.rawName,
      name: menuItem.name,
      expectedPrice: priceCheck.expectedPrice,
      priceVariancePct: priceCheck.priceVariancePct,
      menuItemStatus,
    });
  }

  for (const menuItem of mismatchUpdates.values()) {
    await Item.updateOne(
      { _id: menuItem._id },
      {
        $set: { lastPriceMismatchAt: new Date() },
        $inc: { priceMismatchCount: 1 },
      }
    );
  }

  return reconciled;
};

const rebuildItemsForCafe = async (cafeId) => {
  const cafeObjectId = toObjectId(cafeId);
  const stats = await Transaction.aggregate([
    { $match: { cafeId: cafeObjectId, status: 'approved' } },
    { $unwind: '$items' },
    { $match: { 'items.name': { $nin: [null, ''] } } },
    {
      $group: {
        _id: {
          salesItemId: '$items.salesItemId',
          name: '$items.name',
        },
        rawNames: { $addToSet: '$items.rawName' },
        totalQty: { $sum: '$items.quantity' },
        totalRevenue: {
          $sum: {
            $multiply: [
              { $ifNull: ['$items.unitPrice', 0] },
              '$items.quantity',
            ],
          },
        },
        observedPriceMin: { $min: '$items.unitPrice' },
        observedPriceMax: { $max: '$items.unitPrice' },
        lastSeenAt: { $max: '$date' },
        firstSeenAt: { $min: '$date' },
        lastObservedPrice: { $last: '$items.unitPrice' },
        needsReviewCount: {
          $sum: { $cond: [{ $eq: ['$items.menuItemStatus', 'needs_review'] }, 1, 0] },
        },
        priceMismatchCount: {
          $sum: { $cond: [{ $eq: ['$items.menuItemStatus', 'price_mismatch'] }, 1, 0] },
        },
        lastPriceMismatchAt: {
          $max: {
            $cond: [
              { $eq: ['$items.menuItemStatus', 'price_mismatch'] },
              '$date',
              null,
            ],
          },
        },
      },
    },
  ]);

  const activeIds = stats
    .map((entry) => entry._id.salesItemId)
    .filter(Boolean)
    .map((id) => toObjectId(id));
  const activeNamesWithoutIds = stats
    .filter((entry) => !entry._id.salesItemId)
    .map((entry) => entry._id.name);

  await Item.updateMany(
    {
      cafeId: cafeObjectId,
      ...(activeIds.length > 0 || activeNamesWithoutIds.length > 0
        ? {
            $nor: [
              ...(activeIds.length > 0 ? [{ _id: { $in: activeIds } }] : []),
              ...(activeNamesWithoutIds.length > 0 ? [{ name: { $in: activeNamesWithoutIds } }] : []),
            ],
          }
        : {}),
    },
    { $set: { totalSold: 0, avgPrice: 0 } }
  );

  for (const entry of stats) {
    const totalQty = entry.totalQty || 0;
    const name = entry._id.name;
    const aliases = uniqueStrings(entry.rawNames).filter((alias) => alias !== name);
    const existing = entry._id.salesItemId
      ? await Item.findOne({ _id: entry._id.salesItemId, cafeId: cafeObjectId })
      : await Item.findOne({
          cafeId: cafeObjectId,
          $or: [
            { name },
            { normalizedName: normalizeItemName(name) },
          ],
        });
    const reviewStatus = existing?.reviewStatus && existing.reviewStatus !== 'needs_review'
      ? existing.reviewStatus
      : entry.needsReviewCount > 0 || !existing
        ? 'needs_review'
        : 'matched';
    const mergedAliases = uniqueStrings([...(existing?.aliases || []), ...aliases]);
    const setFields = {
      name,
      normalizedName: normalizeItemName(name),
      aliases: mergedAliases,
      aliasKeys: buildAliasKeys(mergedAliases),
      totalSold: totalQty,
      avgPrice: totalQty > 0 ? parseFloat((entry.totalRevenue / totalQty).toFixed(2)) : 0,
      observedPriceMin: entry.observedPriceMin,
      observedPriceMax: entry.observedPriceMax,
      lastObservedPrice: entry.lastObservedPrice,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      lastPriceMismatchAt: entry.priceMismatchCount > 0 ? entry.lastPriceMismatchAt : null,
      priceMismatchCount: entry.priceMismatchCount || 0,
      reviewStatus,
      isActive: existing?.isActive ?? true,
    };
    if (!existing || existing.category === 'other') setFields.category = inferItemCategory(name);
    if (!existing?.expectedPrice && entry.lastObservedPrice != null) {
      setFields.expectedPrice = entry.lastObservedPrice;
    }

    await Item.findOneAndUpdate(
      existing ? { _id: existing._id } : { cafeId: cafeObjectId, normalizedName: normalizeItemName(name) },
      {
        $set: setFields,
        $setOnInsert: { cafeId: cafeObjectId, source: 'imported' },
      },
      { upsert: true, new: true }
    );
  }
};

const updateTransactionMenuItemLinks = async (cafeId, item, targetItem = item) => {
  const rawNames = uniqueStrings([item.name, ...(item.aliases || [])]);
  const update = {
    'items.$[matched].salesItemId': targetItem._id,
    'items.$[matched].name': targetItem.name,
    'items.$[matched].menuItemStatus': targetItem.reviewStatus === 'ignored' ? 'ignored' : 'matched',
  };
  if (String(item._id) !== String(targetItem._id)) {
    update['items.$[matched].rawName'] = item.name;
  }
  if (targetItem.expectedPrice !== undefined) {
    update['items.$[matched].expectedPrice'] = targetItem.expectedPrice;
  }

  await Transaction.updateMany(
    {
      cafeId,
      $or: [
        { 'items.salesItemId': item._id },
        { 'items.name': { $in: rawNames } },
        { 'items.rawName': { $in: rawNames } },
      ],
    },
    {
      $set: update,
      $unset: { 'items.$[matched].priceVariancePct': '' },
    },
    {
      arrayFilters: [
        {
          $or: [
            { 'matched.salesItemId': item._id },
            { 'matched.name': { $in: rawNames } },
            { 'matched.rawName': { $in: rawNames } },
          ],
        },
      ],
    }
  );
};

const resolveMenuItem = async (cafeId, itemId, { action, targetItemId, expectedPrice, category, aliases, notes }) => {
  const item = await Item.findOne({ _id: itemId, cafeId });
  if (!item) {
    const err = new Error('Item not found');
    err.statusCode = 404;
    throw err;
  }

  if (action === 'map_to') {
    const target = await Item.findOne({ _id: targetItemId, cafeId });
    if (!target) {
      const err = new Error('Target item not found');
      err.statusCode = 404;
      throw err;
    }

    const mergedAliases = uniqueStrings([
      ...(target.aliases || []),
      item.name,
      ...(item.aliases || []),
      ...(aliases || []),
    ]);
    target.aliases = mergedAliases;
    target.aliasKeys = buildAliasKeys(mergedAliases);
    if (expectedPrice !== undefined) target.expectedPrice = Number(expectedPrice);
    if (category) target.category = category;
    target.reviewStatus = 'matched';
    await target.save();

    item.reviewStatus = 'merged';
    item.isActive = false;
    item.mergedInto = target._id;
    await item.save();
    await updateTransactionMenuItemLinks(cafeId, item, target);
    await rebuildItemsForCafe(cafeId);
    return target;
  }

  if (action === 'ignore') {
    item.reviewStatus = 'ignored';
    item.isActive = false;
    if (notes !== undefined) item.notes = notes;
    await item.save();
    await updateTransactionMenuItemLinks(cafeId, item, item);
    await rebuildItemsForCafe(cafeId);
    return item;
  }

  item.reviewStatus = 'matched';
  item.isActive = true;
  if (expectedPrice !== undefined) item.expectedPrice = Number(expectedPrice);
  if (category) item.category = category;
  if (notes !== undefined) item.notes = notes;
  if (aliases !== undefined) {
    item.aliases = uniqueStrings(aliases);
    item.aliasKeys = buildAliasKeys(item.aliases);
  }
  item.normalizedName = normalizeItemName(item.name);
  await item.save();
  await updateTransactionMenuItemLinks(cafeId, item, item);
  await rebuildItemsForCafe(cafeId);
  return item;
};

const findMatchCandidates = async (cafeId, item, limit = 3) => {
  const key = normalizeItemName(item.name);
  if (!key) return [];
  const tokens = new Set(key.split(' ').filter(Boolean));
  const candidates = await Item.find({
    cafeId,
    _id: { $ne: item._id },
    isActive: { $ne: false },
    reviewStatus: 'matched',
  })
    .sort({ totalSold: -1 })
    .limit(100)
    .lean();

  return candidates
    .map((candidate) => {
      const candidateKey = normalizeItemName(candidate.name);
      const candidateTokens = new Set(candidateKey.split(' ').filter(Boolean));
      const overlap = [...tokens].filter((token) => candidateTokens.has(token)).length;
      const union = new Set([...tokens, ...candidateTokens]).size || 1;
      const tokenScore = overlap / union;
      const nameScore = stringSimilarity(key, candidateKey);
      const aliasScore = Math.max(
        0,
        ...(candidate.aliases || []).map((alias) => stringSimilarity(key, normalizeItemName(alias)))
      );
      const score = Math.max(tokenScore, nameScore, aliasScore);
      return { item: candidate, score };
    })
    .filter((candidate) => candidate.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

module.exports = {
  normalizeItemName,
  buildAliasKeys,
  reconcileTransactionItems,
  rebuildItemsForCafe,
  resolveMenuItem,
  findMatchCandidates,
  updateTransactionMenuItemLinks,
};
