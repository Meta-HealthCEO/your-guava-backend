// PATCH /uploads/:id/mapping: re-import an upload under a new mapping.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const r2 = require('../../services/r2.service');
const parser = require('../../services/parser.service');
const { zonedDateKey } = require('../../utils/timezone');
const { normaliseTransactionStatus } = require('../../utils/transactionStatus');
const { computeDedupKey } = require('../../utils/dedupKey');
const { clearApiCache } = require('../../middleware/cache.middleware');
const {
  CONFIRMATION_KEY_MAX_LENGTH, sha256, validateMapping, getCafeTimezone, assertParsedRowsImportable, confirmationMappingHash,
  confirmationResponse,
} = require('./shared');
const {
  recoverStaleParsingUpload, snapshotUploadState, lockUploadForParsing, touchParsingLease, commitParsedUpload, restoreUploadAfterFailure,
} = require('./lease');
const { schedulePostImportMaintenance } = require('./jobs');

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
      dayKey: row.dateKey || zonedDateKey(row.date, timezone),
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
          receiptIdentityKey(existing.receiptId, zonedDateKey(existing.date, timezone))
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

module.exports = {
  assertRemapHasImportableRows, remap,
};
