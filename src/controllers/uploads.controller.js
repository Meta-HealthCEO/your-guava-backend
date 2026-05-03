const Upload = require('../models/Upload.model');
const Cafe = require('../models/Cafe.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');

const REQUIRED = ['date', 'items', 'total'];

const confirm = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { columnMapping, itemsMode } = req.body;
    const cafeId = req.user.cafeId;

    const missing = REQUIRED.filter((f) => !columnMapping?.[f]);
    if (missing.length > 0) {
      return res.status(400).json({ success: false, message: `Missing required mapping: ${missing.join(', ')}` });
    }

    const upload = await Upload.findOne({ _id: id, cafeId });
    if (!upload) return res.status(404).json({ success: false, message: 'Upload not found' });
    if (upload.status === 'completed' || upload.status === 'parsing') {
      return res.status(409).json({ success: false, message: `Upload already ${upload.status}` });
    }

    upload.status = 'parsing';
    upload.columnMapping = columnMapping;
    upload.itemsMode = itemsMode || 'packed';
    await upload.save();

    try {
      const buffer = await r2.downloadFile(upload.r2Key);
      const ext = upload.fileName.split('.').pop().toLowerCase();
      const result = await ingestion.ingestParsedRows(buffer, {
        cafeId,
        uploadId: upload._id,
        columnMapping,
        itemsMode: upload.itemsMode,
        fileExt: ext,
      });

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

      // Persist mapping for next time, only when wizard route was used
      if (upload.posType === 'wizard') {
        await Cafe.findByIdAndUpdate(cafeId, {
          $set: { savedColumnMapping: { ...columnMapping, itemsMode: upload.itemsMode } },
        });
      }

      await Cafe.findByIdAndUpdate(cafeId, {
        $set: { dataUploaded: true, lastSyncAt: new Date() },
      });

      return res.status(200).json({
        success: true,
        uploadId: upload._id,
        stats: upload.stats,
        dateRange: upload.dateRange,
      });
    } catch (err) {
      upload.status = 'failed';
      upload.errorMessage = err.message;
      await upload.save();
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

module.exports = { confirm, list };
