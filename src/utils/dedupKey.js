const crypto = require('crypto');

/**
 * Computes a deterministic SHA-256 digest used as a synthetic transaction
 * identity when no receipt ID is available in the source export.
 *
 * When sourceFingerprint + sourceRowNumbers are provided the identity is tied
 * to a physical row (or grouped set of rows) in that exact source file. This
 * makes retrying/re-uploading the same file idempotent without treating two
 * legitimate, identical baskets as the same sale.
 *
 * @param {object} input
 * @param {string} input.date     ISO date string YYYY-MM-DD
 * @param {string} [input.time]   HH:MM (optional)
 * @param {number} input.total
 * @param {Array<{name: string, quantity: number}>} input.items
 * @param {string} [input.sourceFingerprint] SHA-256 digest of the source file
 * @param {number[]} [input.sourceRowNumbers] Original source row numbers
 * @returns {string} 64-char SHA-256 hex
 */
const computeDedupKey = ({
  date,
  time,
  total,
  items,
  sourceFingerprint,
  sourceRowNumbers,
}) => {
  const normalizedRows = [...new Set(
    (Array.isArray(sourceRowNumbers) ? sourceRowNumbers : [])
      .map(Number)
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  )].sort((a, b) => a - b);

  if (sourceFingerprint && normalizedRows.length > 0) {
    const input = `source-v1|${sourceFingerprint}|${normalizedRows.join(',')}`;
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  // Legacy callers without source metadata retain a deterministic business
  // signature. New upload ingestion always supplies source metadata.
  const sortedItems = [...(items || [])]
    .map((i) => ({ name: i.name, quantity: i.quantity }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const itemsJoined = sortedItems.map((i) => `${i.name}x${i.quantity}`).join('|');
  const input = `legacy-v1|${date}|${time || ''}|${total}|${itemsJoined}`;
  return crypto.createHash('sha256').update(input).digest('hex');
};

module.exports = { computeDedupKey };
