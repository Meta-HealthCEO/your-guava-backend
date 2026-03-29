/**
 * Yoco API integration service.
 *
 * NOTE: Yoco's POS transaction API availability needs confirmation.
 * CSV/XLSX upload is the primary data source for now.
 * These functions are placeholders until the Yoco API is confirmed.
 */

/**
 * Checks whether a given Yoco API key is valid.
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
const checkConnection = async (apiKey) => {
  // TODO: Replace with real Yoco API ping once endpoint is confirmed
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    return false;
  }
  return true;
};

/**
 * Fetches transactions from the Yoco API for a given date range.
 * @param {string} apiKey
 * @param {Date|string} startDate
 * @param {Date|string} endDate
 * @returns {Promise<Array>}
 */
const getTransactions = async (apiKey, startDate, endDate) => {
  // TODO: Implement when Yoco transaction API endpoint is confirmed
  // Likely endpoint: GET https://online.yoco.com/v1/charges/
  // with date range filters and pagination
  console.warn('[yoco] getTransactions not yet implemented — returning empty array');
  return [];
};

module.exports = {
  checkConnection,
  getTransactions,
};
