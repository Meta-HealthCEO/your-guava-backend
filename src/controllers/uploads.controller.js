const Upload = require('../models/Upload.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Forecast = require('../models/Forecast.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const { updateForecastActuals, generateWeekForecast } = require('../services/forecast.service');
const { computeDedupKey } = require('../utils/dedupKey');
const { clearApiCache } = require('../middleware/cache.middleware');

const REQUIRED = ['date', 'items', 'total'];
const VALID_ITEMS_MODES = new Set(['packed', 'line-per-row']);

const validateMapping = (upload, columnMapping, itemsMode) => {
  if (!VALID_ITEMS_MODES.has(itemsMode || 'packed')) {
    return `Invalid itemsMode: ${itemsMode}`;
  }

  const missing = REQUIRED.filter((f) => !columnMapping?.[f]);
  if (missing.length > 0) {
    return `Missing required mapping: ${missing.join(', ')}`;
  }

  const headers = Array.isArray(upload?.headers) ? upload.headers : [];
  if (headers.length > 0) {
    const invalid = Object.entries(columnMapping || {})
      .filter(([, value]) => value != null && value !== '' && !headers.includes(value))
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

  if (result.imported === 0 && result.errors > 0 && result.errors >= result.totalRows) {
    const err = new Error('No valid transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }
};

const assertParsedRowsImportable = (parsed) => {
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
};

const duplicateFilterForRow = (cafeId, row) => {
  if (row.receiptId) return { cafeId, receiptId: row.receiptId };

  const dedupKey = computeDedupKey({
    date: row.date.toISOString().slice(0, 10),
    time: row.date.toISOString().slice(11, 16),
    total: row.total,
    items: row.items,
  });
  return { cafeId, dedupKey };
};

const assertRemapHasImportableRows = async (parsed, cafeId, uploadId) => {
  const approvedRows = parsed.rows.filter((row) => (row.status || 'approved').toLowerCase() === 'approved');
  if (approvedRows.length === 0) {
    const err = new Error('No approved transaction rows could be imported with this mapping');
    err.statusCode = 400;
    throw err;
  }

  let duplicateRows = 0;
  for (const row of approvedRows) {
    const existing = await Transaction.findOne({
      ...duplicateFilterForRow(cafeId, row),
      uploadId: { $ne: uploadId },
    }).select('_id').lean();
    if (existing) duplicateRows++;
  }

  if (duplicateRows === approvedRows.length) {
    const err = new Error('Every valid row already exists in another upload; remap would leave this upload empty');
    err.statusCode = 409;
    throw err;
  }
};

const startOfToday = () => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
};

const invalidatePlanningForecasts = async (cafeId) => {
  await Forecast.deleteMany({ cafeId, date: { $gte: startOfToday() } });
};

const fillActualsForRange = async (cafeId, dateRange) => {
  if (!dateRange?.firstDate || !dateRange?.lastDate) return;
  const start = new Date(dateRange.firstDate);
  start.setHours(0, 0, 0, 0);
  const end = new Date(dateRange.lastDate);
  end.setHours(0, 0, 0, 0);
  const cursor = new Date(start);
  while (cursor <= end) {
    try {
      await updateForecastActuals(cafeId, new Date(cursor));
    } catch (err) {
      console.error('[uploads] updateForecastActuals failed for', cursor.toISOString(), err.message);
    }
    cursor.setDate(cursor.getDate() + 1);
  }
};

const localDownload = async (req, res, next) => {
  try {
    const { key, expires, sig } = req.query;
    const filePath = r2.getLocalDownloadPath(String(key || ''), String(expires || ''), String(sig || ''));
    return res.download(filePath);
  } catch (error) {
    return next(error);
  }
};

const confirm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode } = req.body;
    const cafeId = req.user.cafeId;

    const upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload) return res.status(404).json({ success: false, message: 'Upload not found' });
    if (upload.status === 'completed' || upload.status === 'parsing') {
      return res.status(409).json({ success: false, message: `Upload already ${upload.status}` });
    }

    const mappingError = validateMapping(upload, columnMapping, itemsMode);
    if (mappingError) {
      return res.status(400).json({ success: false, message: mappingError });
    }

    const previousUploadState = {
      status: upload.status,
      columnMapping: upload.columnMapping?.toObject ? upload.columnMapping.toObject() : { ...(upload.columnMapping || {}) },
      itemsMode: upload.itemsMode,
      stats: upload.stats?.toObject ? upload.stats.toObject() : { ...(upload.stats || {}) },
      dateRange: upload.dateRange?.toObject ? upload.dateRange.toObject() : { ...(upload.dateRange || {}) },
      completedAt: upload.completedAt,
    };

    upload.status = 'parsing';
    upload.columnMapping = columnMapping;
    upload.itemsMode = itemsMode || 'packed';
    await upload.save();

    try {
      const buffer = await r2.downloadFile(upload.r2Key);
      if (!Buffer.isBuffer(buffer)) {
        const err = new Error('Original upload file is unavailable');
        err.statusCode = 503;
        throw err;
      }
      const ext = upload.fileName.split('.').pop().toLowerCase();
      await Transaction.deleteMany({ cafeId, uploadId: upload._id });
      const result = await ingestion.ingestParsedRows(buffer, {
        cafeId,
        uploadId: upload._id,
        columnMapping,
        itemsMode: upload.itemsMode,
        fileExt: ext,
      });
      assertImportableResult(result);

      upload.status = 'completed';
      upload.stats = {
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
        totalRows: result.totalRows,
      };
      upload.dateRange = result.dateRange;
      upload.completedAt = new Date();
      await upload.save();

      // Invalidate planning forecasts so they regenerate with fresh data.
      // Keep historical forecasts so imported actuals can be matched to the original predictions.
      await invalidatePlanningForecasts(cafeId);

      // Re-generate fresh forecasts for the next 7 days using the new data,
      // and back-fill actuals for any forecast dates the upload covers.
      await generateWeekForecast(cafeId).catch((err) => console.error('[uploads] week regen failed:', err.message));
      await fillActualsForRange(cafeId, result.dateRange);

      // Persist mapping for next time, only when wizard route was used
      if (upload.posType === 'wizard') {
        await Cafe.findByIdAndUpdate(cafeId, {
          $set: { savedColumnMapping: { ...columnMapping, itemsMode: upload.itemsMode } },
        });
      }

      await Cafe.findByIdAndUpdate(cafeId, {
        $set: { dataUploaded: true, lastSyncAt: new Date() },
      });

      clearApiCache();
      return res.status(200).json({
        success: true,
        uploadId: upload._id,
        stats: upload.stats,
        dateRange: upload.dateRange,
      });
    } catch (err) {
      upload.status = previousUploadState.status;
      upload.columnMapping = previousUploadState.columnMapping;
      upload.itemsMode = previousUploadState.itemsMode;
      upload.stats = previousUploadState.stats;
      upload.dateRange = previousUploadState.dateRange;
      upload.completedAt = previousUploadState.completedAt;
      upload.errorMessage = err.message;
      await upload.save();
      await Transaction.deleteMany({ cafeId, uploadId: upload._id });
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
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

    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
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
    const { columnMapping, itemsMode } = req.body;
    const cafeId = req.user.cafeId;

    const upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }
    if (upload.status === 'parsing' || upload.status === 'pending_mapping') {
      return res.status(409).json({ success: false, message: `Cannot remap while ${upload.status}` });
    }

    const mappingError = validateMapping(upload, columnMapping, itemsMode);
    if (mappingError) {
      return res.status(400).json({ success: false, message: mappingError });
    }

    const previousUploadState = {
      status: upload.status,
      columnMapping: upload.columnMapping?.toObject ? upload.columnMapping.toObject() : { ...(upload.columnMapping || {}) },
      itemsMode: upload.itemsMode,
      stats: upload.stats?.toObject ? upload.stats.toObject() : { ...(upload.stats || {}) },
      dateRange: upload.dateRange?.toObject ? upload.dateRange.toObject() : { ...(upload.dateRange || {}) },
      completedAt: upload.completedAt,
    };

    upload.status = 'parsing';
    upload.columnMapping = columnMapping;
    upload.itemsMode = itemsMode || 'packed';
    await upload.save();

    try {
      // 1. Parse first (read-only — can fail without any side effects)
      const buffer = await r2.downloadFile(upload.r2Key);
      if (!Buffer.isBuffer(buffer)) {
        const err = new Error('Original upload file is unavailable');
        err.statusCode = 503;
        throw err;
      }
      const ext = upload.fileName.split('.').pop().toLowerCase();
      const { parseBuffer } = require('../services/parser.service');
      const parsed = await parseBuffer(buffer, {
        columnMapping,
        itemsMode: upload.itemsMode,
        fileExt: ext,
      });
      assertParsedRowsImportable(parsed);
      await assertRemapHasImportableRows(parsed, cafeId, upload._id);

      // 2. Parse succeeded — now safe to delete existing transactions
      await Transaction.deleteMany({ cafeId, uploadId: upload._id });

      // 3. Persist the already-parsed rows (no second parse)
      const result = await ingestion.persistParsedRows(parsed, {
        cafeId,
        uploadId: upload._id,
      });
      assertImportableResult(result);

      upload.status = 'completed';
      upload.stats = {
        imported: result.imported,
        skipped: result.skipped,
        errors: result.errors,
        totalRows: result.totalRows,
      };
      upload.dateRange = result.dateRange;
      upload.completedAt = new Date();
      upload.errorMessage = undefined;
      await upload.save();

      // Invalidate planning forecasts so they regenerate with fresh data.
      // Keep historical forecasts so imported actuals can be matched to the original predictions.
      await invalidatePlanningForecasts(cafeId);

      // Re-generate fresh forecasts for the next 7 days using the new data,
      // and back-fill actuals for any forecast dates the upload covers.
      await generateWeekForecast(cafeId).catch((err) => console.error('[uploads] week regen failed:', err.message));
      await fillActualsForRange(cafeId, result.dateRange);

      clearApiCache();
      return res.status(200).json({
        success: true,
        uploadId: upload._id,
        stats: upload.stats,
        dateRange: upload.dateRange,
      });
    } catch (err) {
      upload.status = previousUploadState.status;
      upload.columnMapping = previousUploadState.columnMapping;
      upload.itemsMode = previousUploadState.itemsMode;
      upload.stats = previousUploadState.stats;
      upload.dateRange = previousUploadState.dateRange;
      upload.completedAt = previousUploadState.completedAt;
      upload.errorMessage = err.message;
      await upload.save();
      throw err;
    }
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const upload = await Upload.findOne({ _id: req.params.id, cafeId });
    if (!upload || upload.status === 'deleted') {
      return res.status(404).json({ success: false, message: 'Upload not found' });
    }

    const dateRange = upload.dateRange;
    await Transaction.deleteMany({ cafeId, uploadId: upload._id });
    await ingestion.rebuildItemsForCafe(cafeId);
    await invalidatePlanningForecasts(cafeId);
    await fillActualsForRange(cafeId, dateRange);
    try { await r2.deleteFile(upload.r2Key); } catch (err) {
      console.error('[uploads] r2 delete failed:', err.message);
    }
    upload.status = 'deleted';
    await upload.save();

    clearApiCache();
    return res.status(200).json({ success: true });
  } catch (error) {
    next(error);
  }
};

module.exports = { localDownload, confirm, list, detail, rows, remap, remove };
