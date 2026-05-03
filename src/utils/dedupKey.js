const crypto = require('crypto');

/**
 * Computes a deterministic SHA1 hex digest used as a synthetic transaction
 * dedup key when no receipt ID is available in the source CSV.
 *
 * @param {object} input
 * @param {string} input.date     ISO date string YYYY-MM-DD
 * @param {string} [input.time]   HH:MM (optional)
 * @param {number} input.total
 * @param {Array<{name: string, quantity: number}>} input.items
 * @returns {string} 40-char SHA1 hex
 */
const computeDedupKey = ({ date, time, total, items }) => {
  const sortedItems = [...(items || [])]
    .map((i) => ({ name: i.name, quantity: i.quantity }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const itemsJoined = sortedItems.map((i) => `${i.name}x${i.quantity}`).join('|');
  const input = `${date}|${time || ''}|${total}|${itemsJoined}`;
  return crypto.createHash('sha1').update(input).digest('hex');
};

module.exports = { computeDedupKey };
