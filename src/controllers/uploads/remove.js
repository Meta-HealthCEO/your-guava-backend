// DELETE /uploads/:id: remove an upload, its rows and its storage object.
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const Upload = require('../../models/Upload.model');
const Transaction = require('../../models/Transaction.model');
const Cafe = require('../../models/Cafe.model');
const Forecast = require('../../models/Forecast.model');
const GeneratedInsight = require('../../models/GeneratedInsight.model');
const r2 = require('../../services/r2.service');
const ingestion = require('../../services/ingestion.service');
const parser = require('../../services/parser.service');
const { clearApiCache } = require('../../middleware/cache.middleware');
const { getCafeTimezone, STORAGE_CLEANUP_PENDING } = require('./shared');
const { recoverStaleParsingUpload } = require('./lease');
const { fillActualsForRange, invalidateAiInsights } = require('./jobs');

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
  remove,
};
