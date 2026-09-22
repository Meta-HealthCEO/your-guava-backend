const mongoose = require('mongoose');
const Item = require('../models/Item.model');
const Transaction = require('../models/Transaction.model');
const { inferItemCategory } = require('../utils/itemCategory');

const MAX_CANONICAL_NAME_CHARS = 200;
const MAX_ALIASES = 50;
const MATCH_CANDIDATE_POOL = 100;
const MATCH_SCORE_THRESHOLD = 0.35;

/**
 * The key that decides menu-item identity: two names with the same key are
 * treated as the same product by the sales-line lookup, by the rebuild and by
 * the duplicate check on POST /api/items.
 *
 * It used to delete every parenthesised group first, on the theory that
 * "(Blend)" and "(None)" were till noise. They are not — a parenthesised
 * modifier is how a Yoco export writes a variant, so "Cappuccino (Small)" and
 * "Cappuccino (Large)" collapsed into one Item with one expectedPrice, the
 * large sale was rewritten to disk as a small, and the owner could not add the
 * missing variant by hand because create answered 409. Case and punctuation are
 * levelled; every word the till printed survives into the key.
 */
const normalizeItemName = (name = '') =>
  String(name)
    .slice(0, MAX_CANONICAL_NAME_CHARS)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// The looser key identity deliberately no longer uses: the name with its
// modifiers removed, kept only for telling siblings apart below.
const baseItemName = (name = '') =>
  normalizeItemName(String(name || '').replace(/\([^)]*\)/g, ' '));

const itemModifierKey = (name = '') =>
  (String(name || '').match(/\([^)]*\)/g) || [])
    .map((group) => normalizeItemName(group))
    .filter(Boolean)
    .sort()
    .join(' ');

// Two names that share a base but carry different modifiers are deliberate
// siblings — a small and a large, a blend and a decaf. Nothing may quietly join
// them back up: not the fuzzy match suggestions (approving one would undo the
// split), and not the alias the rebuild learns from a transaction's rawName,
// which is how a cafe whose history was merged under the old key would
// otherwise re-merge itself on its very next import.
const areSiblingVariants = (a = '', b = '') => {
  const [modifierA, modifierB] = [itemModifierKey(a), itemModifierKey(b)];
  if (!modifierA || !modifierB || modifierA === modifierB) return false;
  const base = baseItemName(a);
  return Boolean(base) && base === baseItemName(b);
};

const toObjectId = (id) => (
  id instanceof mongoose.Types.ObjectId ? id : new mongoose.Types.ObjectId(id)
);

const uniqueStrings = (values = []) =>
  [...new Set(
    values
      .map((value) => String(value || '').trim())
      .filter((value) => value && value.length <= MAX_CANONICAL_NAME_CHARS)
  )].slice(0, MAX_ALIASES);

const buildAliasKeys = (aliases = []) =>
  uniqueStrings(aliases).map(normalizeItemName).filter(Boolean);

const withSession = (query, session) => (session ? query.session(session) : query);

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
  // The edit distance is at least the length difference, so the score can never
  // exceed shortest/longest. Below the threshold the matrix cannot change the
  // answer, and skipping it is what keeps the reconciliation page — up to 100
  // items against 100 candidates each — off the event loop.
  if (Math.min(a.length, b.length) / longest < MATCH_SCORE_THRESHOLD) return 0;
  return 1 - (levenshteinDistance(a, b) / longest);
};

// A line whose unitPrice is a basket average spread across a multi-item
// receipt (parser priceSource 'derived') is not a price observation. Rows
// written before the flag existed carry no priceSource and are exact.
const isExactPrice = (item = {}) => item.priceSource !== 'derived';

const newMenuItemFields = (name, item = {}) => {
  const unitPrice = Number.isFinite(Number(item.unitPrice)) ? Number(item.unitPrice) : undefined;
  // Only an exact line price may seed what the item is expected to cost, or be
  // shown as an observed price. A basket average from a multi-item receipt made
  // every later exact observation look like a price change.
  const learnedPrice = isExactPrice(item) ? unitPrice : undefined;
  return {
    normalizedName: normalizeItemName(name),
    category: inferItemCategory(name),
    expectedPrice: learnedPrice,
    source: 'imported',
    reviewStatus: 'needs_review',
    aliases: [],
    aliasKeys: [],
    avgPrice: unitPrice,
    observedPriceMin: learnedPrice,
    observedPriceMax: learnedPrice,
    lastObservedPrice: learnedPrice,
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
  };
};

/**
 * Resolves a whole basket of raw sales names against the cafe's menu in one
 * query, and remembers anything created along the way.
 *
 * Every line used to run its own findOne with a three-branch $or, awaited in
 * turn inside the ingest transaction, so a 50k-row import was tens of thousands
 * of sequential round trips — minutes of pure latency inside a 60-second
 * transaction that then rolled the whole import back.
 */
const createMenuItemResolver = async (cafeId, names, session) => {
  const keys = [...new Set(names.map(normalizeItemName).filter(Boolean))];
  const clauses = [{ name: { $in: names } }];
  if (keys.length > 0) {
    clauses.push({ normalizedName: { $in: keys } }, { aliasKeys: { $in: keys } });
  }
  const documents = await withSession(Item.find({ cafeId, $or: clauses }), session);

  const byName = new Map();
  const byKey = new Map();
  const byAliasKey = new Map();
  const register = (document) => {
    if (!byName.has(document.name)) byName.set(document.name, document);
    if (document.normalizedName && !byKey.has(document.normalizedName)) {
      byKey.set(document.normalizedName, document);
    }
    for (const aliasKey of document.aliasKeys || []) {
      if (!byAliasKey.has(aliasKey)) byAliasKey.set(aliasKey, document);
    }
  };
  documents.forEach(register);

  return {
    register,
    // Exact name, then the normalised key, then an alias. The old single $or
    // left the winner to whichever index the planner happened to use, so an
    // item that carried another item's name as an alias could out-rank it.
    resolve: (name) => {
      const key = normalizeItemName(name);
      return byName.get(name) || byKey.get(key) || byAliasKey.get(key) || null;
    },
  };
};

const createMenuItem = async (cafeId, name, item, session) => {
  // A read-then-create loses to a second writer — another upload confirm for
  // the same cafe, or the Yoco sync running alongside one — on the unique
  // {cafeId, name} index. The bulk import path rethrows that E11000 and aborts
  // the entire upload; the row-at-a-time path used to file it as a duplicate
  // transaction and drop a real sale silently. An upsert lets the loser read
  // the winner's document instead of raising at all.
  try {
    return await withSession(Item.findOneAndUpdate(
      { cafeId, name },
      { $setOnInsert: newMenuItemFields(name, item) },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ), session);
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await withSession(Item.findOne({ cafeId, name }), session);
    if (winner) return winner;
    throw error;
  }
};

const priceCheckForItem = (menuItem, item = {}) => {
  const expectedPrice = Number(menuItem.expectedPrice);
  const observedPrice = Number(item.unitPrice);
  if (
    !isExactPrice(item) ||
    !Number.isFinite(expectedPrice) || expectedPrice <= 0 || !Number.isFinite(observedPrice)
  ) {
    return { expectedPrice: Number.isFinite(expectedPrice) ? expectedPrice : undefined };
  }

  const priceVariancePct = Number((((observedPrice - expectedPrice) / expectedPrice) * 100).toFixed(2));
  const tolerance = Number.isFinite(Number(menuItem.priceTolerancePct))
    ? Number(menuItem.priceTolerancePct)
    : 10;
  const isMismatch = Math.abs(priceVariancePct) > tolerance;

  return { expectedPrice, priceVariancePct, isMismatch };
};

const reconcileTransactionItems = async (cafeId, items = [], options = {}) => {
  const { session } = options;
  const reconciled = [];
  const mismatchUpdates = new Map();

  const lineNames = items.map((item) => String(item.name || '').trim() || 'Unknown Item');
  const resolver = await createMenuItemResolver(cafeId, [...new Set(lineNames)], session);
  const menuItems = new Map();
  for (const [index, name] of lineNames.entries()) {
    if (menuItems.has(name)) continue;
    let menuItem = resolver.resolve(name);
    if (!menuItem) {
      menuItem = await createMenuItem(cafeId, name, items[index], session);
      // So a second line in the same basket whose name differs only in
      // punctuation resolves to the row we just wrote rather than a twin.
      resolver.register(menuItem);
    }
    menuItems.set(name, menuItem);
  }

  for (const [index, item] of items.entries()) {
    const rawName = String(item.name || '').trim();
    const menuItem = menuItems.get(lineNames[index]);
    const priceCheck = priceCheckForItem(menuItem, item);
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
      },
      session ? { session } : undefined
    );
  }

  return reconciled;
};

const IS_DERIVED_LINE = { $eq: ['$items.priceSource', 'derived'] };
const exactOnly = (expression) => ({ $cond: [IS_DERIVED_LINE, null, expression] });

const definedValues = (values = []) => values.filter((value) => value !== null && value !== undefined);
const minOf = (values) => {
  const defined = definedValues(values);
  return defined.length > 0 ? defined.reduce((a, b) => (b < a ? b : a)) : null;
};
const maxOf = (values) => {
  const defined = definedValues(values);
  return defined.length > 0 ? defined.reduce((a, b) => (b > a ? b : a)) : null;
};

// The later of two {date, order} price observations, applying the same tiebreak
// the aggregation does: _id decides when a date-only export puts a whole day's
// sales at midnight.
const laterExactPrice = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  const byDate = new Date(a.date).getTime() - new Date(b.date).getTime();
  if (byDate !== 0) return byDate > 0 ? a : b;
  return String(a.order) >= String(b.order) ? a : b;
};

const cafeSalesStats = (cafeObjectId, session) => {
  const aggregation = Transaction.aggregate([
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
        // Only an exact line is a price observation, so the range shown on the
        // very page built for checking prices cannot start at a basket average.
        // $min/$max skip nulls, so a derived line simply does not count; an item
        // that has only ever sold inside baskets reports null instead.
        observedPriceMin: { $min: exactOnly('$items.unitPrice') },
        observedPriceMax: { $max: exactOnly('$items.unitPrice') },
        lastSeenAt: { $max: '$date' },
        firstSeenAt: { $min: '$date' },
        // The newest exact price, chosen by comparing {date, order} composites
        // rather than by sorting the history first. The pipeline used to open
        // with a blocking $sort of every approved transaction purely to make
        // this deterministic — around 300MB at 500k transactions, past Mongo's
        // 100MB limit, and inside the upload's transaction it cannot even spill
        // to disk, so the import aborted and rolled back. BSON compares
        // sub-documents field by field in order, so $max over these is exactly
        // "the latest row, _id breaking a same-instant tie".
        lastExactPrice: { $max: exactOnly({ date: '$date', order: '$_id', value: '$items.unitPrice' }) },
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
  if (session) aggregation.session(session);
  return aggregation;
};

// Two stats groups can land on one Item — the same name under both a null and a
// non-null salesItemId, or two spellings that share a key. Written one at a
// time the second overwrote the first's totalSold instead of adding to it, so
// the item reported a fraction of its real volume to the forecast and to the
// review queue's sort order.
const groupStatsByTargetItem = (stats, resolveExisting) => {
  const merged = new Map();
  for (const entry of stats) {
    const existing = resolveExisting(entry);
    const key = existing ? `id:${existing._id}` : `key:${normalizeItemName(entry._id.name)}`;
    const group = merged.get(key);
    if (group) group.entries.push(entry);
    else merged.set(key, { existing, entries: [entry] });
  }
  return [...merged.values()];
};

const combineStats = (entries, existing) => {
  const sum = (field) => entries.reduce((total, entry) => total + (entry[field] || 0), 0);
  const collect = (field) => entries.map((entry) => entry[field]);
  // The item keeps the name it already has when the history still uses it, and
  // otherwise the spelling it sold most under, so two groups landing on one
  // Item cannot rename it at random.
  const byVolume = [...entries].sort(
    (a, b) => (b.totalQty || 0) - (a.totalQty || 0) || String(a._id.name).localeCompare(String(b._id.name))
  );
  const name = existing && entries.some((entry) => entry._id.name === existing.name)
    ? existing.name
    : byVolume[0]._id.name;

  return {
    name,
    totalQty: sum('totalQty'),
    totalRevenue: sum('totalRevenue'),
    needsReviewCount: sum('needsReviewCount'),
    priceMismatchCount: sum('priceMismatchCount'),
    observedPriceMin: minOf(collect('observedPriceMin')),
    observedPriceMax: maxOf(collect('observedPriceMax')),
    firstSeenAt: minOf(collect('firstSeenAt')),
    lastSeenAt: maxOf(collect('lastSeenAt')),
    lastPriceMismatchAt: maxOf(collect('lastPriceMismatchAt')),
    lastExactPrice: collect('lastExactPrice').reduce(laterExactPrice, null),
    rawNames: entries.flatMap((entry) => entry.rawNames || []),
  };
};

const rebuiltItemFields = (combined, existing) => {
  const { name, totalQty } = combined;
  // Fields the owner set by hand are theirs. The rebuild used to relearn all
  // three from sales — before the PUT's own 200 had been written — so an alias
  // could not be removed and a cleared price could not be cleared.
  const manual = new Set(existing?.manualFields || []);
  // An alias that is a sibling variant of the item's own name can only have
  // come from the old match key, which merged the variants in the first place.
  // Left in aliasKeys it re-merges them on the next import, so it is dropped
  // whether it was stored earlier or has just been observed as a rawName.
  const keep = (list) => uniqueStrings(list)
    .filter((alias) => alias !== name && !areSiblingVariants(alias, name));
  const aliases = manual.has('aliases')
    ? keep(existing?.aliases || [])
    : keep([...(existing?.aliases || []), ...combined.rawNames]);

  const fields = {
    name,
    normalizedName: normalizeItemName(name),
    aliases,
    aliasKeys: buildAliasKeys(aliases),
    totalSold: totalQty,
    // Revenue per unit over every line, derived ones included: the forecast
    // multiplies this by predicted quantity, so it has to reconcile with what
    // the till actually took, unlike the observed price range above.
    avgPrice: totalQty > 0 ? parseFloat((combined.totalRevenue / totalQty).toFixed(2)) : 0,
    observedPriceMin: combined.observedPriceMin,
    observedPriceMax: combined.observedPriceMax,
    lastObservedPrice: combined.lastExactPrice?.value ?? null,
    firstSeenAt: combined.firstSeenAt,
    lastSeenAt: combined.lastSeenAt,
    lastPriceMismatchAt: combined.priceMismatchCount > 0 ? combined.lastPriceMismatchAt : null,
    priceMismatchCount: combined.priceMismatchCount,
    reviewStatus: existing?.reviewStatus && existing.reviewStatus !== 'needs_review'
      ? existing.reviewStatus
      : combined.needsReviewCount > 0 || !existing
        ? 'needs_review'
        : 'matched',
    isActive: existing?.isActive ?? true,
  };
  if (!manual.has('category') && (!existing || existing.category === 'other')) {
    fields.category = inferItemCategory(name);
  }
  if (!manual.has('expectedPrice') && existing?.expectedPrice == null && combined.lastExactPrice?.value != null) {
    fields.expectedPrice = combined.lastExactPrice.value;
  }
  return fields;
};

const rebuildItemsForCafe = async (cafeId, options = {}) => {
  const { session } = options;
  const cafeObjectId = toObjectId(cafeId);
  const stats = await cafeSalesStats(cafeObjectId, session);

  // The cafe's whole menu in one query. Resolving each stats group with its own
  // findOne, then upserting it with its own findOneAndUpdate, was 2 round trips
  // per menu item — 600 sequential queries for a 300-item cafe, on every upload
  // commit, every upload delete and every single menu-item edit.
  const existingItems = await withSession(Item.find({ cafeId: cafeObjectId }).lean(), session);
  const byId = new Map(existingItems.map((document) => [String(document._id), document]));
  const byName = new Map();
  const byKey = new Map();
  for (const document of existingItems) {
    if (!byName.has(document.name)) byName.set(document.name, document);
    if (document.normalizedName && !byKey.has(document.normalizedName)) {
      byKey.set(document.normalizedName, document);
    }
  }
  const resolveExisting = (entry) => (entry._id.salesItemId
    ? byId.get(String(entry._id.salesItemId)) || null
    : byName.get(entry._id.name) || byKey.get(normalizeItemName(entry._id.name)) || null);

  const groups = groupStatsByTargetItem(stats, resolveExisting);
  const activeIds = groups.filter((group) => group.existing).map((group) => group.existing._id);
  const activeNames = groups
    .filter((group) => !group.existing)
    .flatMap((group) => group.entries.map((entry) => entry._id.name));

  await Item.updateMany(
    {
      cafeId: cafeObjectId,
      ...(activeIds.length > 0 || activeNames.length > 0
        ? {
            $nor: [
              ...(activeIds.length > 0 ? [{ _id: { $in: activeIds } }] : []),
              ...(activeNames.length > 0 ? [{ name: { $in: activeNames } }] : []),
            ],
          }
        : {}),
    },
    { $set: { totalSold: 0, avgPrice: 0 } },
    session ? { session } : undefined
  );

  const operations = groups.map(({ existing, entries }) => {
    const fields = rebuiltItemFields(combineStats(entries, existing), existing);
    return {
      updateOne: {
        filter: existing
          ? { _id: existing._id }
          : { cafeId: cafeObjectId, normalizedName: fields.normalizedName },
        update: {
          $set: fields,
          $setOnInsert: { cafeId: cafeObjectId, source: 'imported' },
        },
        upsert: true,
      },
    };
  });
  if (operations.length > 0) {
    await Item.bulkWrite(operations, { ordered: false, ...(session ? { session } : {}) });
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
            // The name/rawName fallback only exists for lines written before
            // they carried an id. Applied to linked lines it let an alias steal
            // another menu item's sales outright: an alias equal to item B's
            // name reassigned every one of B's lines to A on an ordinary PUT,
            // and the next rebuild then zeroed B.
            {
              $and: [
                { 'matched.salesItemId': null },
                {
                  $or: [
                    { 'matched.name': { $in: rawNames } },
                    { 'matched.rawName': { $in: rawNames } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }
  );
};

// Records that a value came from the owner rather than from sales, so the
// rebuild leaves it alone.
const markManualFields = (document, fields = []) => {
  const manual = new Set(document.manualFields || []);
  fields.forEach((field) => manual.add(field));
  document.manualFields = [...manual];
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

    // The merged name goes first. uniqueStrings truncates at MAX_ALIASES, and
    // with the target's own list leading, a target already holding 50 aliases
    // silently dropped the one name the merge existed to record — so the same
    // misspelling came back as a fresh review item after every upload, forever.
    const mergedAliases = uniqueStrings([
      item.name,
      ...(aliases || []),
      ...(item.aliases || []),
      ...(target.aliases || []),
    ]);
    target.aliases = mergedAliases;
    target.aliasKeys = buildAliasKeys(mergedAliases);
    if (expectedPrice !== undefined) {
      target.expectedPrice = Number(expectedPrice);
      markManualFields(target, ['expectedPrice']);
    }
    if (category) {
      target.category = category;
      markManualFields(target, ['category']);
    }
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
  if (expectedPrice !== undefined) {
    item.expectedPrice = Number(expectedPrice);
    markManualFields(item, ['expectedPrice']);
  }
  if (category) {
    item.category = category;
    markManualFields(item, ['category']);
  }
  if (notes !== undefined) item.notes = notes;
  if (aliases !== undefined) {
    item.aliases = uniqueStrings(aliases);
    item.aliasKeys = buildAliasKeys(item.aliases);
    markManualFields(item, ['aliases']);
  }
  item.normalizedName = normalizeItemName(item.name);
  await item.save();
  await updateTransactionMenuItemLinks(cafeId, item, item);
  await rebuildItemsForCafe(cafeId);
  return item;
};

// The pool is the same for every review item on the page bar the self
// exclusion, so it is fetched once and passed in. Re-running it per item cost
// 100 round trips and 10,000 documents for a single reconciliation page load.
const loadMatchCandidatePool = (cafeId) => Item.find({
  cafeId,
  isActive: { $ne: false },
  reviewStatus: 'matched',
})
  .sort({ totalSold: -1 })
  .limit(MATCH_CANDIDATE_POOL)
  .lean();

const findMatchCandidates = async (cafeId, item, { limit = 3, pool = null } = {}) => {
  const key = normalizeItemName(item.name);
  if (!key) return [];
  const tokens = new Set(key.split(' ').filter(Boolean));
  const candidates = (pool || await loadMatchCandidatePool(cafeId)).filter(
    (candidate) => String(candidate._id) !== String(item._id)
      // A sibling variant is a different product on purpose. Offering it as a
      // merge target puts the collapse this key change removed one approval
      // click away from coming back.
      && !areSiblingVariants(item.name, candidate.name)
  );

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
    .filter((candidate) => candidate.score >= MATCH_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

module.exports = {
  normalizeItemName,
  buildAliasKeys,
  markManualFields,
  reconcileTransactionItems,
  rebuildItemsForCafe,
  resolveMenuItem,
  findMatchCandidates,
  loadMatchCandidatePool,
  updateTransactionMenuItemLinks,
};
