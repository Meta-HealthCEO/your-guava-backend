// Constants and helpers every uploads handler shares: mapping validation, importability checks, response shapes.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const crypto = require('crypto');
const { getCafeTimezone } = require('../../utils/timezone');
const { normaliseTransactionStatus } = require('../../utils/transactionStatus');

const REQUIRED = ['date', 'items', 'total'];
const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);

const MAX_LIST_PAGE = 10000;
const STORAGE_CLEANUP_PENDING = 'Stored file cleanup pending; background cleanup will retry.';
const ABANDONED_CLEANUP_CLAIM = 'Removing an abandoned unconfirmed upload.';
const SEVERE_PARTIAL_MIN_ERRORS = 10;
const SEVERE_PARTIAL_ERROR_RATIO = 0.25;
const CONFIRMATION_KEY_MAX_LENGTH = 160;
const MAPPING_FIELDS = [
  'receiptId', 'date', 'time', 'items', 'total', 'tip', 'discount',
  'paymentMethod', 'status', 'quantity',
];

const sha256 = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex');

const confirmationMappingHash = (columnMapping, itemsMode) => sha256(JSON.stringify({
  itemsMode,
  columnMapping: Object.fromEntries(
    MAPPING_FIELDS.map((field) => [field, columnMapping?.[field] || null])
  ),
}));

const sanitizeRowErrors = (rowErrors) =>
  (Array.isArray(rowErrors) ? rowErrors : []).slice(0, 50).map((rowError) => ({
    rowNumber: rowError?.rowNumber,
    reason: String(rowError?.reason || 'Could not import row').slice(0, 500),
  }));

const confirmationResponse = (upload, { replayed = false } = {}) => ({
  success: true,
  uploadId: upload._id,
  stats: upload.stats,
  dateRange: upload.dateRange,
  rowErrors: sanitizeRowErrors(upload.rowErrors),
  maintenance: upload.maintenance || { status: 'queued' },
  replayed,
});

const boundedInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
};

const validateMapping = (upload, columnMapping, itemsMode) => {
  const mode = itemsMode || 'packed';
  if (!VALID_ITEMS_MODES.has(mode)) {
    return `Invalid itemsMode: ${itemsMode}`;
  }

  const required = mode === 'line-per-row' ? [...REQUIRED, 'receiptId'] : REQUIRED;
  const missing = required.filter((f) => !columnMapping?.[f]);
  if (missing.length > 0) {
    return `Missing required mapping: ${missing.join(', ')}`;
  }

  const headers = Array.isArray(upload?.headers) ? upload.headers : [];
  if (headers.length > 0) {
    const invalid = Object.entries(columnMapping || {})
      .filter(([, value]) => value != null && value !== '' && (typeof value !== 'string' || !headers.includes(value)))
      .map(([field, value]) => `${field} -> ${value}`);
    if (invalid.length > 0) {
      return `Mapped columns are not in this file: ${invalid.join(', ')}`;
    }
  }

  return null;
};

const assertImportableResult = (result) => {
  if (result.totalRows === 0) {
    const err = new Error('No transaction rows found in this upload');
    err.statusCode = 400;
    throw err;
  }

  if (result.approvedRows === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  if (result.imported === 0 && result.duplicateRows >= result.approvedRows) {
    const err = new Error('No new transactions were imported; every valid row already exists');
    err.statusCode = 409;
    throw err;
  }

  if (result.imported === 0 && result.errors > 0 && result.errors >= result.totalRows) {
    const err = new Error('No valid transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }
};

const assertParsedRowsImportable = (parsed, { allowSeverePartial = false } = {}) => {
  if (parsed.totalRows === 0) {
    const err = new Error('No transaction rows found in this upload');
    err.statusCode = 400;
    throw err;
  }

  if (parsed.rows.length === 0 && parsed.errors > 0 && parsed.errors >= parsed.totalRows) {
    const err = new Error('No valid transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const approvedRows = parsed.rows.filter((row) => normaliseTransactionStatus(row.status).status === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const errorRatio = parsed.totalRows > 0 ? parsed.errors / parsed.totalRows : 0;
  if (
    !allowSeverePartial &&
    parsed.errors >= SEVERE_PARTIAL_MIN_ERRORS &&
    errorRatio >= SEVERE_PARTIAL_ERROR_RATIO
  ) {
    const err = new Error(
      `${parsed.errors} of ${parsed.totalRows} rows could not be parsed. Fix the mapping or explicitly allow a partial import.`
    );
    err.statusCode = 422;
    err.code = 'SEVERE_PARTIAL_IMPORT';
    err.details = {
      errors: parsed.errors,
      totalRows: parsed.totalRows,
      errorRatio: Number(errorRatio.toFixed(4)),
      rowErrors: sanitizeRowErrors(parsed.rowErrors),
    };
    throw err;
  }
};

module.exports = {
  REQUIRED, VALID_ITEMS_MODES, MAX_LIST_PAGE, STORAGE_CLEANUP_PENDING, ABANDONED_CLEANUP_CLAIM, CONFIRMATION_KEY_MAX_LENGTH,
  sha256, confirmationMappingHash, sanitizeRowErrors, confirmationResponse, boundedInteger, validateMapping,
  assertImportableResult, assertParsedRowsImportable, getCafeTimezone,
};
