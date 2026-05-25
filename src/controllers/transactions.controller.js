const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const Upload = require('../models/Upload.model');
const r2 = require('../services/r2.service');
const ingestion = require('../services/ingestion.service');
const { proposeColumnMapping } = require('../services/anthropic.service');

const REQUIRED_UPLOAD_MAPPING = ['date', 'items', 'total'];
const MIN_HEADER_COUNT = 2;

const cleanupLocalFile = (filePath) => {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch {}
};

const cleanColumnMapping = (mapping = {}, headers = []) => {
  const headerSet = new Set(headers);
  const cleaned = {};
  for (const [key, value] of Object.entries(mapping || {})) {
    if (typeof value === 'string' && headerSet.has(value)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
};

const hasRequiredHeaderMapping = (mapping = {}, headers = []) =>
  REQUIRED_UPLOAD_MAPPING.every((field) => {
    const mappedHeader = mapping?.[field];
    return typeof mappedHeader === 'string' && headers.includes(mappedHeader);
  });

const upload = async (req, res, next) => {
  let filePath;
  let stagedR2Key = null;
  let uploadDocCreated = false;
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const cafeId = req.user.cafeId;
    const userId = req.user.id;
    filePath = req.file.path;
    const fileName = path.basename(req.file.originalname);
    const ext = path.extname(fileName).toLowerCase().slice(1);
    const buffer = fs.readFileSync(filePath);

    // Validate size
    const maxBytes = parseInt(process.env.UPLOAD_MAX_BYTES || '10485760', 10);
    if (buffer.length > maxBytes) {
      cleanupLocalFile(filePath);
      return res.status(400).json({ success: false, message: `File exceeds ${maxBytes} bytes` });
    }

    // Preview headers + sample rows
    const { headers, sampleRows } = await ingestion.previewBuffer(buffer, ext);
    if (!headers || headers.length < MIN_HEADER_COUNT) {
      cleanupLocalFile(filePath);
      return res.status(400).json({ success: false, message: 'Could not parse CSV headers' });
    }

    // Stage to R2
    const r2Key = `uploads/${cafeId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${fileName}`;
    try {
      await r2.uploadFile(buffer, r2Key, req.file.mimetype || 'text/csv');
      stagedR2Key = r2Key;
    } catch (err) {
      cleanupLocalFile(filePath);
      return res.status(503).json({ success: false, message: 'File storage unavailable, please retry' });
    }
    cleanupLocalFile(filePath);

    // Detect format
    let posType, columnMapping, itemsMode;
    let usedSavedMapping = false;
    const yoco = ingestion.yocoMapping();
    if (ingestion.isYocoFormat(headers) && hasRequiredHeaderMapping(yoco.mapping, headers)) {
      posType = 'yoco';
      columnMapping = cleanColumnMapping(yoco.mapping, headers);
      itemsMode = yoco.itemsMode;
    } else {
      posType = 'wizard';
      // Try cafe-saved mapping first
      const cafe = await Cafe.findById(cafeId).lean();
      if (cafe?.savedColumnMapping) {
        const saved = cafe.savedColumnMapping;
        columnMapping = cleanColumnMapping(saved, headers);
        itemsMode = saved.itemsMode || 'packed';
        usedSavedMapping = true;
      } else {
        const proposal = await proposeColumnMapping(headers, sampleRows, {
          orgId: req.user.orgId,
          cafeId,
          userId,
        });
        columnMapping = cleanColumnMapping(proposal.mapping, headers);
        itemsMode = proposal.itemsMode;
      }
    }

    const uploadDoc = await Upload.create({
      cafeId,
      uploadedBy: userId,
      fileName,
      fileSize: buffer.length,
      r2Key,
      posType,
      columnMapping,
      itemsMode,
      headers,
      sampleRows,
      status: 'pending_mapping',
    });
    uploadDocCreated = true;

    const hasRequiredMapping = hasRequiredHeaderMapping(columnMapping, headers);

    return res.status(200).json({
      success: true,
      uploadId: uploadDoc._id,
      posType,
      columnMapping,
      itemsMode,
      headers,
      preview: sampleRows,
      needsConfirmation: posType !== 'yoco' && !(usedSavedMapping && hasRequiredMapping),
    });
  } catch (error) {
    cleanupLocalFile(filePath);
    if (stagedR2Key && !uploadDocCreated) {
      try { await r2.deleteFile(stagedR2Key); } catch {}
    }
    next(error);
  }
};

const getTransactions = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { startDate, endDate, limit = 100, page = 1 } = req.query;

    const query = { cafeId };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const limitNum = Math.min(parseInt(limit, 10) || 100, 500);
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const skip = (pageNum - 1) * limitNum;

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .sort({ date: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Transaction.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      transactions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
};

const getStats = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;

    const transactions = await Transaction.find({
      cafeId,
      status: 'approved',
    })
      .select('date total items')
      .lean();

    if (transactions.length === 0) {
      return res.status(200).json({
        success: true,
        stats: {
          totalTransactions: 0,
          totalRevenue: 0,
          avgDailyRevenue: 0,
          topItems: [],
          firstDate: null,
          lastDate: null,
        },
      });
    }

    // Total revenue
    const totalRevenue = transactions.reduce((sum, tx) => sum + (tx.total || 0), 0);

    // Date range
    const dates = transactions.map((tx) => new Date(tx.date).getTime());
    const firstDate = new Date(Math.min(...dates));
    const lastDate = new Date(Math.max(...dates));
    const firstDay = new Date(firstDate);
    firstDay.setHours(0, 0, 0, 0);
    const lastDay = new Date(lastDate);
    lastDay.setHours(0, 0, 0, 0);
    const dayCount = Math.max(Math.floor((lastDay - firstDay) / (1000 * 60 * 60 * 24)) + 1, 1);
    const avgDailyRevenue = totalRevenue / dayCount;

    // Top 5 items
    const itemCounts = {};
    for (const tx of transactions) {
      for (const item of tx.items || []) {
        itemCounts[item.name] = (itemCounts[item.name] || 0) + item.quantity;
      }
    }
    const topItems = Object.entries(itemCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([name, qty]) => ({ name, qty }));

    return res.status(200).json({
      success: true,
      stats: {
        totalTransactions: transactions.length,
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgDailyRevenue: parseFloat(avgDailyRevenue.toFixed(2)),
        topItems,
        firstDate,
        lastDate,
      },
    });
  } catch (error) {
    next(error);
  }
};

const getDataStatus = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;

    // Find the latest transaction date (most recent data the user has)
    const latest = await Transaction.findOne({ cafeId }).sort({ date: -1 }).select('date').lean();
    const earliest = await Transaction.findOne({ cafeId }).sort({ date: 1 }).select('date').lean();
    const totalCount = await Transaction.countDocuments({ cafeId });

    // Coverage: count distinct dates with transactions in the last 30 days.
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setHours(0, 0, 0, 0);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const coverage = await Transaction.aggregate([
      { $match: { cafeId: new (require('mongoose')).Types.ObjectId(cafeId), date: { $gte: thirtyDaysAgo } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$date' },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Number of days since latest data
    let daysSinceLatest = null;
    if (latest) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const latestDay = new Date(latest.date);
      latestDay.setHours(0, 0, 0, 0);
      daysSinceLatest = Math.max(0, Math.floor((today - latestDay) / 86400000));
    }

    return res.status(200).json({
      success: true,
      data: {
        latestDataDate: latest?.date || null,
        earliestDataDate: earliest?.date || null,
        daysSinceLatest,
        totalTransactions: totalCount,
        coverage30d: coverage.map((c) => ({ date: c._id, count: c.count })),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { upload, getTransactions, getStats, getDataStatus };
