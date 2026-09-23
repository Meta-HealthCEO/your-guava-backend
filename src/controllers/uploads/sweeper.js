// The abandoned-upload sweeper server.js runs on a timer.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const r2 = require('../../services/r2.service');
const { boundedInteger, ABANDONED_CLEANUP_CLAIM, STORAGE_CLEANUP_PENDING } = require('./shared');
const { parsingLeaseMs } = require('./lease');

const DEFAULT_PENDING_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_CLEANUP_BATCH = 100;

const pendingRetentionMs = () => boundedInteger(
  process.env.UPLOAD_PENDING_RETENTION_MS,
  DEFAULT_PENDING_RETENTION_MS,
  60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000
);

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

module.exports = {
  pendingRetentionMs, cleanupAbandonedPendingUploads,
};
