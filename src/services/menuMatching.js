/**
 * Scoring for menu reconciliation's "did you mean" candidates, with a hard
 * ceiling on the work one request may do.
 *
 * Every review item used to be compared with up to 100 candidates and all of
 * their aliases (50 of up to 200 characters) by full Levenshtein, normalising
 * each alias again per comparison: about 2e10 steps for a crafted menu, on
 * the event loop every cafe shares (uploads-catalogue-7). The scores here are
 * exactly the old ones. They are skipped when a cheap bound proves they cannot
 * change the result, and never computed past the request's budget.
 */
const MATCH_SCORE_THRESHOLD = 0.35;
const DEFAULT_MATCH_COMPARISONS = 1_000_000;
const DEFAULT_MATCH_CELLS = 20_000_000;
// Keeps float rounding from ever pruning a score that sits on a boundary.
const EPSILON = 1e-9;
// normalizeItemName emits only a-z, 0-9 and single spaces.
const SLOT_COUNT = 37;

const slotOf = (code) => {
  if (code >= 97 && code <= 122) return code - 97;
  if (code >= 48 && code <= 57) return code - 22;
  if (code === 32) return 36;
  return -1;
};

// A normalised key and its character counts, computed once per request.
const prepareKey = (key) => {
  const counts = new Uint16Array(SLOT_COUNT);
  const present = [];
  let exact = true;
  for (let index = 0; index < key.length; index += 1) {
    const slot = slotOf(key.charCodeAt(index));
    if (slot < 0) {
      exact = false;
      continue;
    }
    if (counts[slot] === 0) present.push(slot);
    counts[slot] += 1;
  }
  return { key, length: key.length, counts, present, exact };
};

// Characters two keys share, with multiplicity. Any edit script leaves at
// most `shared` characters in place, so it needs at least longest - shared
// edits, and shared / longest caps the similarity.
const sharedCharacters = (a, b) => {
  if (!a.exact || !b.exact) return a.length < b.length ? a.length : b.length;
  const small = a.present.length <= b.present.length ? a : b;
  const large = small === a ? b : a;
  let shared = 0;
  // Index loops, not iterators or Math.min: every built-in call in this hot
  // path costs ~200 ns inside jest's sandbox, and there are millions of them.
  const { present } = small;
  for (let index = 0; index < present.length; index += 1) {
    const slot = present[index];
    const x = small.counts[slot];
    const y = large.counts[slot];
    shared += x < y ? x : y;
  }
  return shared;
};

// Two reusable rows: the scorer is synchronous and never re-entered.
let rowA = new Uint16Array(256);
let rowB = new Uint16Array(256);

// The edit distance, or maxDistance + 1 once a whole row is past maxDistance
// (every path to the last cell crosses that row, so none can come back).
// The minimum is spelled out: a Math.min call in this loop costs ~200 ns
// inside jest's sandbox (its realm's Math is never inlined), which turned a
// 70 ms budget into 7 s in the tests that guard it.
const levenshteinWithin = (a, b, maxDistance) => {
  if (rowA.length < b.length + 1) {
    rowA = new Uint16Array(b.length + 1);
    rowB = new Uint16Array(b.length + 1);
  }
  let previous = rowA;
  let current = rowB;
  for (let j = 0; j <= b.length; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = i;
    const code = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j += 1) {
      let value = previous[j - 1] + (code === b.charCodeAt(j - 1) ? 0 : 1);
      const up = previous[j] + 1;
      const left = current[j - 1] + 1;
      if (up < value) value = up;
      if (left < value) value = left;
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length];
};

const createMatchBudget = ({ comparisons = DEFAULT_MATCH_COMPARISONS, cells = DEFAULT_MATCH_CELLS } = {}) =>
  ({ comparisons, cells, exhausted: false });

// The old stringSimilarity, exactly, whenever it could beat `floor` and clear
// the threshold; otherwise 0, which cannot change the candidate's score.
const similarityAbove = (a, b, floor, budget) => {
  const longest = a.length > b.length ? a.length : b.length;
  const shortest = a.length > b.length ? b.length : a.length;
  if (longest === 0) return 0;
  // The old shortcut, verbatim: it answered 0 here, not the true score.
  if (shortest / longest < MATCH_SCORE_THRESHOLD) return 0;
  if (budget.comparisons <= 0) {
    budget.exhausted = true;
    return 0;
  }
  budget.comparisons -= 1;
  const ceiling = sharedCharacters(a, b) / longest;
  if (ceiling + EPSILON < MATCH_SCORE_THRESHOLD || ceiling + EPSILON <= floor) return 0;
  const cells = a.length * b.length;
  if (budget.cells < cells) {
    budget.exhausted = true;
    return 0;
  }
  budget.cells -= cells;
  // One edit of slack past the threshold, so rounding never cuts a real match
  // (an integer ceiling without Math.ceil, for the same reason as the loop).
  const slack = longest * (1 - MATCH_SCORE_THRESHOLD);
  const maxDistance = (slack === (slack | 0) ? slack : (slack | 0) + 1) + 1;
  const distance = levenshteinWithin(a.key, b.key, maxDistance);
  return distance > maxDistance ? 0 : 1 - (distance / longest);
};

// The distinct tokens of a key, sorted, so two keys' overlap is one merge pass.
const tokenList = (key) => {
  const distinct = [...new Set(key.split(' ').filter(Boolean))];
  distinct.sort();
  return distinct;
};

// |A ∩ B| / |A ∪ B| over the distinct tokens, exactly the old set arithmetic,
// as a merge of two sorted lists (no Set.has per token: see sharedCharacters).
const tokenScore = (tokens, candidateTokens) => {
  let overlap = 0;
  let i = 0;
  let j = 0;
  while (i < tokens.length && j < candidateTokens.length) {
    const a = tokens[i];
    const b = candidateTokens[j];
    if (a === b) {
      overlap += 1;
      i += 1;
      j += 1;
    } else if (a < b) i += 1;
    else j += 1;
  }
  return overlap / (tokens.length + candidateTokens.length - overlap || 1);
};

const prepareMatchPool = (pool, { normalize, budget = createMatchBudget() }) => ({
  budget,
  entries: pool.map((item) => {
    const key = normalize(item.name);
    return {
      item,
      id: String(item._id),
      key: prepareKey(key),
      tokens: tokenList(key),
      aliasKeys: (item.aliases || []).map((alias) => prepareKey(normalize(alias))),
    };
  }),
});

const rankMatchCandidates = (item, prepared, { normalize, isSibling = () => false, limit = 3 }) => {
  const key = normalize(item.name);
  if (!key) return [];
  const probe = prepareKey(key);
  const tokens = tokenList(key);
  const itemId = String(item._id);
  const scored = [];
  const { entries } = prepared;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.id === itemId || isSibling(item.name, entry.item.name)) continue;
    let score = tokenScore(tokens, entry.tokens);
    const nameScore = similarityAbove(probe, entry.key, score, prepared.budget);
    if (nameScore > score) score = nameScore;
    const { aliasKeys } = entry;
    for (let alias = 0; alias < aliasKeys.length; alias += 1) {
      const aliasScore = similarityAbove(probe, aliasKeys[alias], score, prepared.budget);
      if (aliasScore > score) score = aliasScore;
    }
    if (score >= MATCH_SCORE_THRESHOLD) scored.push({ item: entry.item, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
};

module.exports = { MATCH_SCORE_THRESHOLD, createMatchBudget, prepareMatchPool, rankMatchCandidates };
