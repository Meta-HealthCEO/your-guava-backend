const mongoose = require('mongoose');
const fs = require('fs');
const crypto = require('crypto');
const Upload = require('../models/Upload.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Forecast = require('../models/Forecast.model');
const GeneratedInsight = require('../models/GeneratedInsight.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const parser = require('../services/parser.service');
const { updateForecastActuals, generateWeekForecast } = require('../services/forecast.service');
const { computeDedupKey } = require('../utils/dedupKey');
const { clearApiCache } = require('../middleware/cache.middleware');

const REQUIRED = ['date', 'items', 'total'];
const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);
const DEFAULT_PARSING_LEASE_MS = 15 * 60 * 1000;
const MAX_PARSING_LEASE_MS = 60 * 60 * 1000;
const DEFAULT_PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_RETRY_MS = 5 * 60 * 1000;
const MAX_MAINTENANCE_RETRY_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAINTENANCE_MAX_ATTEMPTS = 5;
const MAX_CLEANUP_BATCH = 100;
const MAX_ACTUALS_REFRESH_FORECASTS = 366;
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

const parsingLeaseMs = () => boundedInteger(
  process.env.UPLOAD_PARSING_LEASE_MS,
  DEFAULT_PARSING_LEASE_MS,
  60 * 1000,
  MAX_PARSING_LEASE_MS
);

const pendingRetentionMs = () => boundedInteger(
  process.env.UPLOAD_PENDING_RETENTION_MS,
  DEFAULT_PENDING_RETENTION_MS,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
);

const maintenanceMaxAttempts = () => boundedInteger(
  process.env.UPLOAD_MAINTENANCE_MAX_ATTEMPTS,
  DEFAULT_MAINTENANCE_MAX_ATTEMPTS,
  1,
  10
);

const maintenanceRetryDelayMs = (attempts) => {
  const baseDelay = boundedInteger(
    process.env.UPLOAD_MAINTENANCE_RETRY_MS,
    DEFAULT_MAINTENANCE_RETRY_MS,
    1000,
    MAX_MAINTENANCE_RETRY_MS
  );
  return Math.min(
    MAX_MAINTENANCE_RETRY_MS,
    baseDelay * (2 ** Math.max(0, Number(attempts || 1) - 1))
  );
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

  const approvedRows = parsed.rows.filter((row) => (row.status || 'approved').toLowerCase() === 'approved');
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

const recoverStaleParsingUpload = async (upload, cafeId) => {
  if (upload.status !== 'parsing') return upload;
  if (upload.errorMessage === ABANDONED_CLEANUP_CLAIM) {
    const err = new Error('This unconfirmed upload expired and is being removed.');
    err.statusCode = 410;
    throw err;
  }
  const staleBefore = new Date(Date.now() - parsingLeaseMs());
  if (upload.updatedAt > staleBefore) {
    const err = new Error('Upload is already being parsed. Please retry after it finishes.');
    err.statusCode = 409;
    throw err;
  }

  const fallbackStatus = upload.completedAt ? 'completed' : 'failed';
  const recovered = await Upload.findOneAndUpdate(
    {
      _id: upload._id,
      cafeId,
      status: 'parsing',
      updatedAt: { $lte: staleBefore },
    },
    {
      $set: {
        status: fallbackStatus,
        errorMessage: 'Previous import did not finish; the upload is available to retry.',
      },
    },
    { new: true }
  );

  if (!recovered) {
    const err = new Error('Upload status changed while recovering a stale import. Please refresh and retry.');
    err.statusCode = 409;
    throw err;
  }
  return recovered;
};

const lockUploadForParsing = async (upload, cafeId) => {
  const locked = await Upload.findOneAndUpdate(
    {
      _id: upload._id,
      cafeId,
      status: upload.status,
      updatedAt: upload.updatedAt,
    },
    {
      $set: { status: 'parsing' },
      $unset: { errorMessage: '' },
    },
    { new: true }
  );

  if (!locked) {
    const err = new Error('Upload status changed while import was starting. Please refresh and try again.');
    err.statusCode = 409;
    throw err;
  }

  return locked;
};

const touchParsingLease = async (uploadId, cafeId, expectedUpdatedAt) => {
  const touched = await Upload.findOneAndUpdate(
    { _id: uploadId, cafeId, status: 'parsing', updatedAt: expectedUpdatedAt },
    { $currentDate: { updatedAt: true } },
    { new: true }
  );
  if (!touched) {
    const err = new Error('Upload parsing lease was lost. Please refresh before retrying.');
    err.statusCode = 409;
    throw err;
  }
  return touched;
};

const duplicateFilterForRow = (cafeId, row, sourceFingerprint) => {
  if (row.receiptId) return { cafeId, receiptId: row.receiptId };

  const dedupKey = computeDedupKey({
    date: row.date.toISOString().slice(0, 10),
    time: row.date.toISOString().slice(11, 16),
    total: row.total,
    items: row.items,
    sourceFingerprint,
    sourceRowNumbers: row.__sourceRowNumbers,
  });
  return { cafeId, dedupKey };
};

const assertRemapHasImportableRows = async (parsed, cafeId, uploadId, sourceFingerprint) => {
  const approvedRows = parsed.rows.filter((row) => (row.status || 'approved').toLowerCase() === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const identities = approvedRows.map((row) => duplicateFilterForRow(cafeId, row, sourceFingerprint));
  const receiptIds = [...new Set(identities.map((identity) => identity.receiptId).filter(Boolean))];
  const dedupKeys = [...new Set(identities.map((identity) => identity.dedupKey).filter(Boolean))];
  const existingIdentities = new Set();
  const chunks = (values, size = 500) => {
    const result = [];
    for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
    return result;
  };
  const queries = [
    ...chunks(receiptIds).map((values) => ({ receiptId: { $in: values } })),
    ...chunks(dedupKeys).map((values) => ({ dedupKey: { $in: values } })),
  ];
  for (const identityQuery of queries) {
    const existingRows = await Transaction.find({
      cafeId,
      uploadId: { $ne: uploadId },
      ...identityQuery,
    }).select('receiptId dedupKey').lean();
    for (const existing of existingRows) {
      if (existing.receiptId) existingIdentities.add(`receiptId:${existing.receiptId}`);
      if (existing.dedupKey) existingIdentities.add(`dedupKey:${existing.dedupKey}`);
    }
  }
  const duplicateRows = identities.filter((identity) => (
    identity.receiptId
      ? existingIdentities.has(`receiptId:${identity.receiptId}`)
      : existingIdentities.has(`dedupKey:${identity.dedupKey}`)
  )).length;

  if (duplicateRows === approvedRows.length) {
    const err = new Error('Every valid row already exists in another upload; remap would leave this upload empty');
    err.statusCode = 409;
    throw err;
  }
};

const getCafeTimezone = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  return parser.safeTimezone(cafe?.timezone);
};

const invalidatePlanningForecasts = async (cafeId, timezone) => {
  const today = parser.zonedDayStart(new Date(), timezone || await getCafeTimezone(cafeId));
  await Forecast.deleteMany({ cafeId, date: { $gte: today } });
};

const fillActualsForRange = async (cafeId, dateRange, timezone) => {
  if (!dateRange?.firstDate || !dateRange?.lastDate) return;
  const resolvedTimezone = timezone || await getCafeTimezone(cafeId);
  const start = parser.zonedDayStart(dateRange.firstDate, resolvedTimezone);
  const end = parser.zonedDayEnd(dateRange.lastDate, resolvedTimezone);
  const forecasts = await Forecast.find({ cafeId, date: { $gte: start, $lte: end } })
    .select('date')
    .sort({ date: -1 })
    .limit(MAX_ACTUALS_REFRESH_FORECASTS + 1)
    .lean();
  if (forecasts.length > MAX_ACTUALS_REFRESH_FORECASTS) {
    console.warn(
      `[uploads] actuals refresh capped at ${MAX_ACTUALS_REFRESH_FORECASTS} forecasts for cafe ${cafeId}`
    );
  }
  for (const forecast of forecasts.slice(0, MAX_ACTUALS_REFRESH_FORECASTS)) {
    try {
      await updateForecastActuals(cafeId, forecast.date, { timezone: resolvedTimezone });
    } catch (err) {
      console.error('[uploads] updateForecastActuals failed for', forecast.date.toISOString(), err.message);
    }
  }
};

const snapshotUploadState = (upload) => ({
  status: upload.status,
  columnMapping: upload.columnMapping?.toObject
    ? upload.columnMapping.toObject()
    : { ...(upload.columnMapping || {}) },
  itemsMode: upload.itemsMode,
  stats: upload.stats?.toObject ? upload.stats.toObject() : { ...(upload.stats || {}) },
  dateRange: upload.dateRange?.toObject
    ? upload.dateRange.toObject()
    : { ...(upload.dateRange || {}) },
  rowErrors: Array.isArray(upload.rowErrors)
    ? upload.rowErrors.map((rowError) => (
      rowError?.toObject ? rowError.toObject() : { ...rowError }
    ))
    : [],
  completedAt: upload.completedAt,
});

const restoreUploadAfterFailure = async ({
  uploadId,
  cafeId,
  expectedUpdatedAt,
  previousState,
  error,
  rowErrors,
  markFailed,
}) => {
  const status = markFailed && ['pending_mapping', 'failed'].includes(previousState.status)
    ? 'failed'
    : previousState.status;
  const set = {
    status,
    columnMapping: previousState.columnMapping,
    itemsMode: previousState.itemsMode,
    stats: previousState.stats,
    dateRange: previousState.dateRange,
    rowErrors: sanitizeRowErrors(rowErrors || previousState.rowErrors),
    errorMessage: error.message,
  };
  const update = { $set: set };
  if (previousState.completedAt) set.completedAt = previousState.completedAt;
  else update.$unset = { completedAt: '' };

  await Upload.updateOne(
    { _id: uploadId, cafeId, status: 'parsing', updatedAt: expectedUpdatedAt },
    update
  );
};

const commitParsedUpload = async ({
  upload,
  cafeId,
  parsed,
  columnMapping,
  itemsMode,
  persistMapping,
  mappingHash,
  idempotencyKeyHash,
  timezone,
}) => {
  let result;
  let committedUpload;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await ingestion.reconcileParsedRows(parsed, { cafeId, session });
      await Transaction.deleteMany({ cafeId, uploadId: upload._id }).session(session);
      result = await ingestion.persistParsedRows(parsed, {
        cafeId,
        uploadId: upload._id,
        session,
        bulk: true,
        itemsAlreadyReconciled: true,
        rebuildItems: false,
        failOnPersistenceError: true,
        sourceFingerprint: upload.fileFingerprint || sha256(upload.r2Key),
        timezone,
      });
      assertImportableResult(result);
      await ingestion.rebuildItemsForCafe(cafeId, { session });

      committedUpload = await Upload.findOneAndUpdate(
        {
          _id: upload._id,
          cafeId,
          status: 'parsing',
          updatedAt: upload.updatedAt,
        },
        {
          $set: {
            status: 'completed',
            columnMapping,
            itemsMode,
            stats: {
              imported: result.imported,
              skipped: result.skipped,
              errors: result.errors,
              totalRows: result.totalRows,
            },
            dateRange: {
              ...result.dateRange,
              firstDateKey: result.dateRange?.firstDate
                ? parser.zonedDateKey(result.dateRange.firstDate, timezone)
                : undefined,
              lastDateKey: result.dateRange?.lastDate
                ? parser.zonedDateKey(result.dateRange.lastDate, timezone)
                : undefined,
            },
            rowErrors: sanitizeRowErrors(result.rowErrors || parsed.rowErrors),
            completedAt: new Date(),
            confirmation: {
              mappingHash,
              idempotencyKeyHash,
              replayCount: 0,
            },
            maintenance: {
              status: 'queued',
              errors: [],
            },
          },
          $unset: { errorMessage: '' },
        },
        { new: true, session }
      );
      if (!committedUpload) {
        const err = new Error('Upload parsing lease was lost before the import could commit');
        err.statusCode = 409;
        throw err;
      }

      const cafeFields = { dataUploaded: true, lastSyncAt: new Date() };
      if (persistMapping) {
        cafeFields.savedColumnMapping = { ...columnMapping, itemsMode };
      }
      const cafeUpdate = await Cafe.findByIdAndUpdate(
        cafeId,
        { $set: cafeFields },
        { session }
      );
      if (!cafeUpdate) {
        const err = new Error('Cafe not found while completing upload');
        err.statusCode = 404;
        throw err;
      }

      // Readers must never observe forecasts or generated insights based on
      // the pre-import dataset, even if the asynchronous regeneration worker
      // starts later or this process exits immediately after commit.
      const today = parser.zonedDayStart(new Date(), timezone);
      await Forecast.deleteMany({ cafeId, date: { $gte: today } }).session(session);
      await GeneratedInsight.updateOne(
        { cafeId },
        { $set: { invalidatedAt: new Date() } },
        { session }
      );
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    await session.endSession();
  }
  return { upload: committedUpload, result };
};

const invalidateAiInsights = async (cafeId) => {
  try {
    const { invalidateInsights } = require('../services/anthropic.service');
    if (typeof invalidateInsights === 'function') await invalidateInsights(cafeId);
  } catch (error) {
    throw new Error(`AI insight invalidation: ${error.message}`);
  }
};

const runPostImportMaintenance = async (claimedUpload, timezone) => {
  const uploadId = claimedUpload._id;
  const cafeId = claimedUpload.cafeId;
  const dateRange = claimedUpload.dateRange;
  const attemptCount = Number(claimedUpload.maintenance?.attempts || 1);
  const claimStartedAt = claimedUpload.maintenance?.startedAt;
  const errors = [];
  const safely = async (label, operation) => {
    try {
      await operation();
    } catch (error) {
      console.error(`[uploads] ${label} failed:`, error.message);
      errors.push(`${label}: ${error.message}`.slice(0, 500));
    }
  };
  await safely('forecast invalidation', () => invalidatePlanningForecasts(cafeId, timezone));
  await safely('week forecast regeneration', () => generateWeekForecast(cafeId));
  await safely('forecast actuals refresh', () => fillActualsForRange(cafeId, dateRange, timezone));
  await safely('AI insight invalidation', () => invalidateAiInsights(cafeId));
  clearApiCache();

  const maxAttempts = maintenanceMaxAttempts();
  const canRetry = errors.length > 0 && attemptCount < maxAttempts;
  const completedAt = new Date();
  const update = {
    $set: {
      'maintenance.status': errors.length === 0 ? 'completed' : 'partial_failure',
      'maintenance.completedAt': completedAt,
      'maintenance.errors': errors,
    },
    $unset: {
      'maintenance.nextRetryAt': '',
      'maintenance.retryExhaustedAt': '',
    },
  };
  if (canRetry) {
    update.$set['maintenance.nextRetryAt'] = new Date(
      completedAt.getTime() + maintenanceRetryDelayMs(attemptCount)
    );
    delete update.$unset['maintenance.nextRetryAt'];
  } else if (errors.length > 0) {
    update.$set['maintenance.retryExhaustedAt'] = completedAt;
    delete update.$unset['maintenance.retryExhaustedAt'];
  }

  await Upload.updateOne(
    {
      _id: uploadId,
      cafeId,
      status: 'completed',
      'maintenance.status': 'running',
      'maintenance.startedAt': claimStartedAt,
    },
    update
  );
  return errors;
};

const claimPostImportMaintenance = async (candidate) => {
  const now = new Date();
  const maxAttempts = maintenanceMaxAttempts();
  const query = {
    _id: candidate._id,
    cafeId: candidate.cafeId,
    status: 'completed',
    'maintenance.status': candidate.maintenance?.status || 'queued',
    $and: [{
      $or: [
        { 'maintenance.attempts': { $exists: false } },
        { 'maintenance.attempts': { $lt: maxAttempts } },
      ],
    }],
  };
  if (candidate.maintenance?.status === 'running' && candidate.maintenance?.startedAt) {
    query['maintenance.startedAt'] = candidate.maintenance.startedAt;
  }
  if (candidate.maintenance?.status === 'partial_failure') {
    query.$and.push({
      $or: [
        { 'maintenance.nextRetryAt': { $exists: false } },
        { 'maintenance.nextRetryAt': { $lte: now } },
      ],
    });
  }
  return Upload.findOneAndUpdate(
    query,
    {
      $set: {
        'maintenance.status': 'running',
        'maintenance.startedAt': now,
        'maintenance.errors': [],
      },
      $inc: { 'maintenance.attempts': 1 },
      $unset: {
        'maintenance.completedAt': '',
        'maintenance.nextRetryAt': '',
        'maintenance.retryExhaustedAt': '',
      },
    },
    { new: true }
  );
};

const claimAndRunPostImportMaintenance = async (candidate, timezone) => {
  const claimed = await claimPostImportMaintenance(candidate);
  if (!claimed) return false;
  const resolvedTimezone = timezone || await getCafeTimezone(claimed.cafeId);
  const errors = await runPostImportMaintenance(claimed, resolvedTimezone);
  return { status: errors.length === 0 ? 'completed' : 'partial_failure', errors };
};

const schedulePostImportMaintenance = async (uploadId, cafeId, dateRange, timezone) => {
  const candidate = {
    _id: uploadId,
    cafeId,
    dateRange,
    maintenance: { status: 'queued' },
  };
  if (process.env.NODE_ENV === 'test') {
    await claimAndRunPostImportMaintenance(candidate, timezone);
    return;
  }
  setImmediate(() => {
    claimAndRunPostImportMaintenance(candidate, timezone).catch((error) => {
      console.error('[uploads] post-import maintenance failed:', error.message);
    });
  });
};

const recoverPendingUploadMaintenance = async ({
  limit = 10,
  staleAfterMs = parsingLeaseMs(),
} = {}) => {
  const batchLimit = boundedInteger(limit, 10, 1, 50);
  const maxAttempts = maintenanceMaxAttempts();
  const now = new Date();
  const staleBefore = new Date(Date.now() - boundedInteger(
    staleAfterMs,
    parsingLeaseMs(),
    60 * 1000,
    MAX_PARSING_LEASE_MS
  ));
  await Upload.updateMany(
    {
      status: 'completed',
      'maintenance.status': 'running',
      'maintenance.startedAt': { $lte: staleBefore },
      'maintenance.attempts': { $gte: maxAttempts },
    },
    {
      $set: {
        'maintenance.status': 'partial_failure',
        'maintenance.completedAt': now,
        'maintenance.retryExhaustedAt': now,
        'maintenance.errors': [
          `Maintenance stopped after ${maxAttempts} interrupted attempts; manual review is required.`,
        ],
      },
      $unset: { 'maintenance.nextRetryAt': '' },
    }
  );
  const candidates = await Upload.find({
    status: 'completed',
    $and: [
      {
        $or: [
          { 'maintenance.attempts': { $exists: false } },
          { 'maintenance.attempts': { $lt: maxAttempts } },
        ],
      },
      {
        $or: [
          { 'maintenance.status': 'queued' },
          {
            'maintenance.status': 'running',
            'maintenance.startedAt': { $lte: staleBefore },
          },
          {
            'maintenance.status': 'partial_failure',
            $or: [
              { 'maintenance.nextRetryAt': { $exists: false } },
              { 'maintenance.nextRetryAt': { $lte: now } },
            ],
          },
        ],
      },
    ],
  })
    .select('_id cafeId dateRange maintenance')
    .sort({ updatedAt: 1 })
    .limit(batchLimit)
    .lean();

  const summary = { scanned: candidates.length, completed: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const result = await claimAndRunPostImportMaintenance(candidate);
      if (result?.status === 'completed') summary.completed++;
      if (result?.status === 'partial_failure') summary.failed++;
    } catch (error) {
      summary.failed++;
      console.error('[uploads] maintenance recovery failed:', error.message);
    }
  }
  return summary;
};

const cleanupAbandonedPendingUploads = async ({
  olderThanMs = pendingRetentionMs(),
  limit = MAX_CLEANUP_BATCH,
} = {}) => {
  const cutoff = new Date(Date.now() - boundedInteger(
    olderThanMs,
    pendingRetentionMs(),
    60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000
  ));
  const staleCleanupBefore = new Date(Date.now() - parsingLeaseMs());
  const batchLimit = boundedInteger(limit, MAX_CLEANUP_BATCH, 1, MAX_CLEANUP_BATCH);
  const pendingLimit = batchLimit === 1 ? 1 : Math.max(1, Math.floor(batchLimit * 0.75));
  const candidates = await Upload.find({
    $or: [
      { status: 'pending_mapping', updatedAt: { $lte: cutoff } },
      {
        status: 'parsing',
        errorMessage: ABANDONED_CLEANUP_CLAIM,
        updatedAt: { $lte: staleCleanupBefore },
      },
    ],
  }).select('_id r2Key status errorMessage updatedAt').sort({ updatedAt: 1 }).limit(pendingLimit).lean();

  const summary = {
    scanned: candidates.length,
    deleted: 0,
    failed: 0,
    storageScanned: 0,
    storageRetried: 0,
  };
  for (const candidate of candidates) {
    const claimed = await Upload.findOneAndUpdate(
      {
        _id: candidate._id,
        status: candidate.status,
        updatedAt: candidate.updatedAt,
        ...(candidate.status === 'parsing'
          ? { errorMessage: ABANDONED_CLEANUP_CLAIM }
          : {}),
      },
      {
        $set: {
          status: 'parsing',
          errorMessage: ABANDONED_CLEANUP_CLAIM,
        },
      },
      { new: true }
    );
    if (!claimed) continue;

    try {
      await r2.deleteFile(claimed.r2Key);
    } catch (error) {
      summary.failed++;
      await Upload.updateOne(
        { _id: claimed._id, status: 'parsing', updatedAt: claimed.updatedAt },
        {
          $set: {
            status: 'pending_mapping',
            errorMessage: 'Could not remove expired upload storage; cleanup will retry.',
          },
        }
      );
      continue;
    }

    try {
      const marked = await Upload.updateOne(
        { _id: claimed._id, status: 'parsing', updatedAt: claimed.updatedAt },
        {
          $set: {
            status: 'deleted',
            errorMessage: 'Unconfirmed upload expired and its stored file was removed.',
            r2Key: `deleted/${claimed._id}`,
            fileName: 'deleted-upload',
            fileSize: 0,
            headers: [],
            sampleRows: [],
            rowErrors: [],
            columnMapping: {},
          },
          $unset: {
            fileFingerprint: '',
            confirmation: '',
            dateRange: '',
            completedAt: '',
          },
        }
      );
      if (marked.modifiedCount === 1) summary.deleted++;
      else summary.failed++;
    } catch (error) {
      summary.failed++;
      console.error('[uploads] expired upload storage was removed but status finalization failed:', error.message);
    }
  }

  const retryLimit = Math.max(0, batchLimit - candidates.length);
  if (retryLimit > 0) {
    const storageRetries = await Upload.find({
      status: 'deleted',
      errorMessage: STORAGE_CLEANUP_PENDING,
    }).select('_id r2Key').sort({ updatedAt: 1 }).limit(retryLimit).lean();
    summary.storageScanned = storageRetries.length;
    for (const upload of storageRetries) {
      try {
        await r2.deleteFile(upload.r2Key);
        const cleared = await Upload.updateOne(
          { _id: upload._id, status: 'deleted', errorMessage: STORAGE_CLEANUP_PENDING },
          { $unset: { errorMessage: '' } }
        );
        if (cleared.modifiedCount === 1) summary.storageRetried++;
      } catch (error) {
        summary.failed++;
      }
    }
  }
  return summary;
};

const localDownload = async (req, res, next) => {
  try {
    const { key, expires, sig } = req.query;
    const filePath = r2.getLocalDownloadPath(String(key || ''), String(expires || ''), String(sig || ''));
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) throw Object.assign(new Error('Stored upload not found'), { code: 'ENOENT' });
    } catch (error) {
      if (error.code === 'ENOENT') {
        error.statusCode = 404;
        error.message = 'Stored upload not found';
      }
      throw error;
    }
    return res.download(filePath, (error) => {
      if (!error) return;
      if (error.code === 'ENOENT') {
        error.statusCode = 404;
        error.message = 'Stored upload not found';
      }
      if (res.headersSent) return res.destroy(error);
      return next(error);
    });
  } catch (error) {
    return next(error);
  }
};

const confirm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      columnMapping,
      itemsMode = 'packed',
      allowPartialImport = false,
    } = req.body;
    const cafeId = req.user.cafeId;
    const idempotencyKey = String(req.get?.('Idempotency-Key') || '').trim();
    if (idempotencyKey.length > CONFIRMATION_KEY_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: 'Idempotency-Key is too long' });
    }
    const mappingHash = confirmationMappingHash(columnMapping, itemsMode);
    const idempotencyKeyHash = idempotencyKey ? sha256(idempotencyKey) : undefined;

    let upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);
    if (upload.status === 'completed') {
      if (upload.confirmation?.mappingHash && upload.confirmation.mappingHash !== mappingHash) {
        return res.status(409).json({
          success: false,
          message: 'Upload already completed with a different mapping. Use remap to change it.',
        });
      }
      upload = await Upload.findOneAndUpdate(
        { _id: upload._id, cafeId, status: 'completed' },
        { $inc: { 'confirmation.replayCount': 1 } },
        { new: true }
      );
      return res.status(200).json(confirmationResponse(upload, { replayed: true }));
    }

    const mappingError = validateMapping(upload, columnMapping, itemsMode);
    if (mappingError) {
      return res.status(400).json({ success: false, message: mappingError });
    }

    const previousUploadState = snapshotUploadState(upload);
    const timezone = await getCafeTimezone(cafeId);
    upload = await lockUploadForParsing(upload, cafeId);
    let expectedUpdatedAt = upload.updatedAt;
    let parsed;
    let result;

    try {
      const buffer = await r2.downloadFile(upload.r2Key);
      if (!Buffer.isBuffer(buffer)) {
        const err = new Error('Original upload file is unavailable');
        err.statusCode = 503;
        throw err;
      }
      const ext = upload.fileName.split('.').pop().toLowerCase();
      parsed = await parser.parseBuffer(buffer, {
        columnMapping,
        itemsMode,
        fileExt: ext,
        timezone,
      });
      assertParsedRowsImportable(parsed, { allowSeverePartial: allowPartialImport === true });
      upload = await touchParsingLease(upload._id, cafeId, expectedUpdatedAt);
      expectedUpdatedAt = upload.updatedAt;

      const committed = await commitParsedUpload({
        upload,
        cafeId,
        parsed,
        columnMapping,
        itemsMode,
        persistMapping: upload.posType === 'wizard',
        mappingHash,
        idempotencyKeyHash,
        timezone,
      });
      upload = committed.upload;
      result = committed.result;
    } catch (err) {
      const rowErrors = result?.rowErrors || parsed?.rowErrors || previousUploadState.rowErrors;
      await restoreUploadAfterFailure({
        uploadId: upload._id,
        cafeId,
        expectedUpdatedAt,
        previousState: previousUploadState,
        error: err,
        rowErrors,
        markFailed: true,
      });
      throw err;
    }

    clearApiCache();
    await schedulePostImportMaintenance(upload._id, cafeId, result.dateRange, timezone);
    return res.status(200).json(confirmationResponse(upload));
  } catch (error) {
    next(error);
  }
};

const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, MAX_LIST_PAGE));
    const skip = (page - 1) * limit;

    const [uploads, total] = await Promise.all([
      Upload.find({ cafeId, status: { $ne: 'deleted' } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('uploadedBy', 'name email')
        .lean(),
      Upload.countDocuments({ cafeId, status: { $ne: 'deleted' } }),
    ]);

    return res.status(200).json({
      success: true,
      uploads,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

const detail = async (req, res, next) => {
  try {
    const upload = await Upload.findOne({ _id: req.params.id, cafeId: req.user.cafeId })
      .populate('uploadedBy', 'name email')
      .lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    const maintenanceIsStale = upload.maintenance?.status === 'running' &&
      upload.maintenance?.startedAt &&
      new Date(upload.maintenance.startedAt) <= new Date(Date.now() - parsingLeaseMs());
    const maintenanceRetryIsDue = upload.maintenance?.status === 'partial_failure' &&
      Number(upload.maintenance?.attempts || 0) < maintenanceMaxAttempts() &&
      (
        !upload.maintenance?.nextRetryAt ||
        new Date(upload.maintenance.nextRetryAt) <= new Date()
      );
    if (upload.status === 'completed' && (
      upload.maintenance?.status === 'queued' || maintenanceIsStale || maintenanceRetryIsDue
    )) {
      setImmediate(() => {
        claimAndRunPostImportMaintenance(upload).catch((error) => {
          console.error('[uploads] request-triggered maintenance recovery failed:', error.message);
        });
      });
    }
    const downloadUrl = await r2.getSignedDownloadUrl(upload.r2Key, 900);
    return res.status(200).json({ success: true, upload, downloadUrl });
  } catch (error) {
    next(error);
  }
};

const rows = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const upload = await Upload.findOne({ _id: req.params.id, cafeId }).lean();
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    const limit = Math.max(1, Math.min(parseInt(req.query.limit, 10) || 50, 200));
    const page = Math.max(1, Math.min(parseInt(req.query.page, 10) || 1, MAX_LIST_PAGE));
    const skip = (page - 1) * limit;

    const [transactions, total] = await Promise.all([
      Transaction.find({ cafeId, uploadId: upload._id })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Transaction.countDocuments({ cafeId, uploadId: upload._id }),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    next(error);
  }
};

const remap = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode = 'packed', allowPartialImport = false } = req.body;
    const cafeId = req.user.cafeId;

    let upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);
    if (upload.status === 'pending_mapping') {
      return res.status(409).json({ success: false, message: `Cannot remap while ${upload.status}` });
    }

    const mappingError = validateMapping(upload, columnMapping, itemsMode);
    if (mappingError) {
      return res.status(400).json({ success: false, message: mappingError });
    }

    const previousUploadState = snapshotUploadState(upload);
    const timezone = await getCafeTimezone(cafeId);
    upload = await lockUploadForParsing(upload, cafeId);
    let expectedUpdatedAt = upload.updatedAt;
    let parsed;
    let result;

    try {
      // 1. Parse first (read-only — can fail without any side effects)
      const buffer = await r2.downloadFile(upload.r2Key);
      if (!Buffer.isBuffer(buffer)) {
        const err = new Error('Original upload file is unavailable');
        err.statusCode = 503;
        throw err;
      }
      const ext = upload.fileName.split('.').pop().toLowerCase();
      parsed = await parser.parseBuffer(buffer, {
        columnMapping,
        itemsMode,
        fileExt: ext,
        timezone,
      });
      assertParsedRowsImportable(parsed, { allowSeverePartial: allowPartialImport === true });
      await assertRemapHasImportableRows(
        parsed,
        cafeId,
        upload._id,
        upload.fileFingerprint || sha256(upload.r2Key)
      );

      // 2. Parse succeeded — now safe to delete existing transactions
      upload = await touchParsingLease(upload._id, cafeId, expectedUpdatedAt);
      expectedUpdatedAt = upload.updatedAt;

      const committed = await commitParsedUpload({
        upload,
        cafeId,
        parsed,
        columnMapping,
        itemsMode,
        persistMapping: false,
        mappingHash: confirmationMappingHash(columnMapping, itemsMode),
        idempotencyKeyHash: undefined,
        timezone,
      });
      upload = committed.upload;
      result = committed.result;

      // Invalidate planning forecasts so they regenerate with fresh data.
      // Keep historical forecasts so imported actuals can be matched to the original predictions.
    } catch (err) {
      await restoreUploadAfterFailure({
        uploadId: upload._id,
        cafeId,
        expectedUpdatedAt,
        previousState: previousUploadState,
        error: err,
        rowErrors: previousUploadState.rowErrors,
        markFailed: false,
      });
      throw err;
    }

    clearApiCache();
    await schedulePostImportMaintenance(upload._id, cafeId, result.dateRange, timezone);
    return res.status(200).json(confirmationResponse(upload));
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    let upload = await Upload.findOne({ _id: req.params.id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    upload = await recoverStaleParsingUpload(upload, cafeId);

    const dateRange = upload.dateRange;
    const timezone = await getCafeTimezone(cafeId);
    const today = parser.zonedDayStart(new Date(), timezone);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await Transaction.deleteMany({ cafeId, uploadId: upload._id }).session(session);
        await ingestion.rebuildItemsForCafe(cafeId, { session });
        await Forecast.deleteMany({ cafeId, date: { $gte: today } }).session(session);
        await GeneratedInsight.updateOne(
          { cafeId },
          { $set: { invalidatedAt: new Date() } },
          { session }
        );
        const remainingTransactions = await Transaction.countDocuments({ cafeId }).session(session);
        const cafeStateUpdate = remainingTransactions > 0
          ? { $set: { dataUploaded: true, lastSyncAt: new Date() } }
          : { $set: { dataUploaded: false }, $unset: { lastSyncAt: '' } };
        await Cafe.updateOne({ _id: cafeId }, cafeStateUpdate, { session });
        const deletedUpload = await Upload.findOneAndUpdate(
          {
            _id: upload._id,
            cafeId,
            status: upload.status,
            updatedAt: upload.updatedAt,
          },
          {
            $set: {
              status: 'deleted',
              errorMessage: STORAGE_CLEANUP_PENDING,
              fileName: 'deleted-upload',
              fileSize: 0,
              headers: [],
              sampleRows: [],
              rowErrors: [],
              columnMapping: {},
            },
            $unset: {
              fileFingerprint: '',
              confirmation: '',
              dateRange: '',
              completedAt: '',
            },
          },
          { new: true, session }
        );
        if (!deletedUpload) {
          const error = new Error('Upload changed while deletion was starting. Please refresh and retry.');
          error.statusCode = 409;
          throw error;
        }
        upload = deletedUpload;
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
    } finally {
      await session.endSession();
    }

    try { await fillActualsForRange(cafeId, dateRange, timezone); } catch (error) {
      console.error('[uploads] delete actuals refresh failed:', error.message);
    }
    try {
      await r2.deleteFile(upload.r2Key);
      await Upload.updateOne(
        { _id: upload._id, status: 'deleted', errorMessage: STORAGE_CLEANUP_PENDING },
        {
          $set: { r2Key: `deleted/${upload._id}` },
          $unset: { errorMessage: '' },
        }
      );
    } catch (error) {
      console.error('[uploads] stored file cleanup deferred:', error.message);
    }

    try {
      await invalidateAiInsights(cafeId);
    } catch (error) {
      console.error('[uploads] delete AI insight invalidation failed:', error.message);
    }
    clearApiCache();
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  localDownload,
  confirm,
  list,
  detail,
  rows,
  remap,
  remove,
  cleanupAbandonedPendingUploads,
  recoverPendingUploadMaintenance,
};
