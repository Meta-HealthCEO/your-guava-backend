const Transaction = require('../models/Transaction.model');
const { computeDedupKey } = require('../utils/dedupKey');
const { safeTimezone, zonedDateKey } = require('../utils/timezone');

/**
 * The one rule for "do we already hold this sale?" (BE-11-T05). The write path
 * (ingestion.service) and the remap pre-check (controllers/uploads/remap.js) each
 * had a copy, and they disagreed about the trading day of a row without dateKey.
 *
 * A receipt number is only unique within a cafe-local trading day on tills that
 * restart their numbering, so a receipt identity carries the day. A receipt-less
 * row is identified by computeDedupKey over its UTC date and time: that key is
 * stored on every imported row, so its inputs must never change.
 */
const IDENTITY_QUERY_CHUNK_SIZE = 500;

const chunksOf = (values, size = IDENTITY_QUERY_CHUNK_SIZE) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const transactionIdentity = (row, sourceFingerprint, timezone) => {
  if (row.receiptId) {
    return { type: 'receiptId', value: row.receiptId, dayKey: row.dateKey || zonedDateKey(row.date, safeTimezone(timezone)) };
  }
  return {
    type: 'dedupKey',
    value: computeDedupKey({
      date: row.date.toISOString().slice(0, 10),
      time: row.date.toISOString().slice(11, 16),
      total: row.total,
      items: row.items,
      sourceFingerprint,
      sourceRowNumbers: row.__sourceRowNumbers,
    }),
  };
};

const identityComparisonKey = (identity) => (identity.type === 'receiptId'
  ? `receiptId:${identity.value}|${identity.dayKey}`
  : `${identity.type}:${identity.value}`);

// The keys a stored row answers to. It keeps only the instant, so its trading day is
// recomputed in the cafe's zone, exactly as the write path computed it.
const storedIdentityKeys = (stored, timezone) => [
  ...(stored.receiptId
    ? [identityComparisonKey({ type: 'receiptId', value: stored.receiptId, dayKey: zonedDateKey(stored.date, timezone) })]
    : []),
  ...(stored.dedupKey ? [identityComparisonKey({ type: 'dedupKey', value: stored.dedupKey })] : []),
];

const findExistingIdentities = async (cafeId, identities, { session, timezone, excludeUploadId } = {}) => {
  const zone = safeTimezone(timezone);
  const valuesOf = (type) => [...new Set(identities.filter((identity) => identity.type === type).map((identity) => identity.value))];
  const queries = [
    ...chunksOf(valuesOf('receiptId')).map((chunk) => ({ receiptId: { $in: chunk } })),
    ...chunksOf(valuesOf('dedupKey')).map((chunk) => ({ dedupKey: { $in: chunk } })),
  ];
  const existing = new Set();
  for (const identityQuery of queries) {
    const filter = { cafeId, ...identityQuery, ...(excludeUploadId ? { uploadId: { $ne: excludeUploadId } } : {}) };
    let query = Transaction.find(filter).select('receiptId dedupKey date');
    if (session) query = query.session(session);
    for (const stored of await query.lean()) {
      for (const key of storedIdentityKeys(stored, zone)) existing.add(key);
    }
  }
  return existing;
};

module.exports = {
  IDENTITY_QUERY_CHUNK_SIZE,
  chunksOf,
  transactionIdentity,
  identityComparisonKey,
  storedIdentityKeys,
  findExistingIdentities,
};
