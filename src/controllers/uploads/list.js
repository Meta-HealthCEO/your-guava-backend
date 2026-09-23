// GET /uploads: the paged list with its projection (BE-01-T07).
// Moved from uploads.controller.js by BE-11-T03; behaviour unchanged.
const Upload = require('../../models/Upload.model');
const { MAX_LIST_PAGE } = require('./shared');

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

module.exports = {
  UPLOAD_LIST_FIELDS, list,
};
