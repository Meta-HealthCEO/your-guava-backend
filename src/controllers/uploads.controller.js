const mongoose = require('mongoose');
const fs = require('fs');
const Upload = require('../models/Upload.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Forecast = require('../models/Forecast.model');
const GeneratedInsight = require('../models/GeneratedInsight.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const parser = require('../services/parser.service');
const { normaliseTransactionStatus } = require('../utils/transactionStatus');
const { computeDedupKey } = require('../utils/dedupKey');
const { clearApiCache } = require('../middleware/cache.middleware');
const {
  MAX_LIST_PAGE, STORAGE_CLEANUP_PENDING, ABANDONED_CLEANUP_CLAIM, CONFIRMATION_KEY_MAX_LENGTH, sha256, confirmationMappingHash,
  confirmationResponse, boundedInteger, validateMapping, assertParsedRowsImportable, getCafeTimezone,
} = require('./uploads/shared');
const {
  parsingLeaseMs, recoverStaleParsingUpload, lockUploadForParsing, touchParsingLease, snapshotUploadState, restoreUploadAfterFailure,
  commitParsedUpload,
} = require('./uploads/lease');
const {
  maintenanceMaxAttempts, fillActualsForRange, invalidateAiInsights, claimAndRunPostImportMaintenance, schedulePostImportMaintenance, recoverPendingUploadMaintenance,
} = require('./uploads/jobs');

const DEFAULT_PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CLEANUP_BATCH = 100;

const pendingRetentionMs = () => boundedInteger(
  process.env.UPLOAD_PENDING_RETENTION_MS,
  DEFAULT_PENDING_RETENTION_MS,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
);

/**
 * Identity a remapped row would be stored under. A receipt number is only
 * unique within a cafe-local trading day (plenty of tills restart numbering
 * each morning), so it is paired with the day exactly as the write path and
 * the unique index do; keyed on the number alone, a reused "#0001" on another
 * day was refused as a duplicate.
 */
const duplicateIdentityForRow = (row, sourceFingerprint, timezone) => {
  if (row.receiptId) {
    return {
      receiptId: row.receiptId,
      dayKey: row.dateKey || parser.zonedDateKey(row.date, timezone),
    };
  }

  const dedupKey = computeDedupKey({
    date: row.date.toISOString().slice(0, 10),
    time: row.date.toISOString().slice(11, 16),
    total: row.total,
    items: row.items,
    sourceFingerprint,
    sourceRowNumbers: row.__sourceRowNumbers,
  });
  return { dedupKey };
};

const receiptIdentityKey = (receiptId, dayKey) => `receiptId:${receiptId}|${dayKey}`;

const assertRemapHasImportableRows = async (parsed, cafeId, uploadId, sourceFingerprint, timezone) => {
  const approvedRows = parsed.rows.filter((row) => normaliseTransactionStatus(row.status).status === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  const identities = approvedRows.map((row) => duplicateIdentityForRow(row, sourceFingerprint, timezone));
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
    }).select('receiptId dedupKey date').lean();
    for (const existing of existingRows) {
      // Stored rows keep only the instant; the trading day is recomputed in
      // the cafe's timezone, as the write path does.
      if (existing.receiptId) {
        existingIdentities.add(
          receiptIdentityKey(existing.receiptId, parser.zonedDateKey(existing.date, timezone))
        );
      }
      if (existing.dedupKey) existingIdentities.add(`dedupKey:${existing.dedupKey}`);
    }
  }
  const duplicateRows = identities.filter((identity) => (
    identity.receiptId
      ? existingIdentities.has(receiptIdentityKey(identity.receiptId, identity.dayKey))
      : existingIdentities.has(`dedupKey:${identity.dedupKey}`)
  )).length;

  if (duplicateRows === approvedRows.length) {
    const err = new Error('Every valid row already exists in another upload; remap would leave this upload empty');
    err.statusCode = 409;
    throw err;
  }
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
        // The key was stored on the first confirm and never read, so a client that
        // reused one key for two different mappings got the same advice as an owner
        // deliberately changing their columns. They are different problems: one is a
        // bug to fix, the other is a feature to use, and only the caller can tell
        // them apart if we say which happened.
        if (idempotencyKeyHash && upload.confirmation?.idempotencyKeyHash === idempotencyKeyHash) {
          return res.status(409).json({
            success: false,
            code: 'IDEMPOTENCY_KEY_REUSED',
            message: 'This Idempotency-Key was already used for a different mapping. '
              + 'Use a new key, or remap the upload to change its columns.',
          });
        }
        return res.status(409).json({
          success: false,
          code: 'MAPPING_ALREADY_COMMITTED',
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

// What the history table draws, and nothing else. sampleRows, headers and
// rowErrors can be megabytes per upload and are served by GET /uploads/:id;
// listing 200 of them was enough to exhaust the process (uploads-catalogue-5).
// An inclusion projection, so a field added to the schema later stays out of
// the list until someone decides it belongs there.
const UPLOAD_LIST_FIELDS = [
  '_id', 'cafeId', 'uploadedBy', 'fileName', 'fileSize', 'posType', 'mappingSource', 'itemsMode', 'status',
  'stats', 'dateRange', 'errorMessage', 'completedAt', 'maintenance', 'createdAt', 'updatedAt',
].join(' ');

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
        .select(UPLOAD_LIST_FIELDS)
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
    // Remap deliberately discarded its key, so a retried re-import looked like a
    // fresh one. Record it like confirm does.
    const remapKey = String(req.get?.('Idempotency-Key') || '').trim();
    if (remapKey.length > CONFIRMATION_KEY_MAX_LENGTH) {
      return res.status(400).json({ success: false, message: 'Idempotency-Key is too long' });
    }
    const remapKeyHash = remapKey ? sha256(remapKey) : undefined;

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
        upload.fileFingerprint || sha256(upload.r2Key),
        timezone
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
        idempotencyKeyHash: remapKeyHash,
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
        // Count what this upload actually contributed before removing it, rather
        // than trusting stats.imported - a re-map rewrites the rows without
        // rewriting the stat. An upload that contributed nothing (staged and
        // abandoned, or a duplicate that imported no new rows) changed none of the
        // model's inputs, so deleting it must not wipe the planning horizon or
        // invalidate insights. Doing so meant tidying up a stranded upload cost an
        // owner every forecast they had.
        const contributedRows = await Transaction.countDocuments({
          cafeId,
          uploadId: upload._id,
        }).session(session);

        if (contributedRows > 0) {
          await Transaction.deleteMany({ cafeId, uploadId: upload._id }).session(session);
          await ingestion.rebuildItemsForCafe(cafeId, { session });
          await Forecast.deleteMany({ cafeId, date: { $gte: today } }).session(session);
          await GeneratedInsight.updateOne(
            { cafeId },
            { $set: { invalidatedAt: new Date() } },
            { session }
          );
        }
        if (contributedRows > 0) {
          const remainingTransactions = await Transaction.countDocuments({ cafeId }).session(session);
          const cafeStateUpdate = remainingTransactions > 0
            ? { $set: { dataUploaded: true, lastSyncAt: new Date() } }
            : { $set: { dataUploaded: false }, $unset: { lastSyncAt: '' } };
          await Cafe.updateOne({ _id: cafeId }, cafeStateUpdate, { session });
        }
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
