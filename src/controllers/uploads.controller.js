const mongoose = require('mongoose');
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
  STORAGE_CLEANUP_PENDING, CONFIRMATION_KEY_MAX_LENGTH, sha256, confirmationMappingHash, confirmationResponse, validateMapping,
  assertParsedRowsImportable, getCafeTimezone,
} = require('./uploads/shared');
const {
  recoverStaleParsingUpload, lockUploadForParsing, touchParsingLease, snapshotUploadState, restoreUploadAfterFailure, commitParsedUpload,
} = require('./uploads/lease');
const {
  fillActualsForRange, invalidateAiInsights, schedulePostImportMaintenance, recoverPendingUploadMaintenance,
} = require('./uploads/jobs');
const { cleanupAbandonedPendingUploads } = require('./uploads/sweeper');
const { localDownload } = require('./uploads/download');
const { list } = require('./uploads/list');
const { detail, rows } = require('./uploads/detail');
const { confirm } = require('./uploads/confirm');

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
