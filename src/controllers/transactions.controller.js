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

const upload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }
    const cafeId = req.user.cafeId;
    const userId = req.user.id;
    const filePath = req.file.path;
    const fileName = path.basename(req.file.originalname);
    const ext = path.extname(fileName).toLowerCase().slice(1);
    const buffer = fs.readFileSync(filePath);

    // Validate size
    const maxBytes = parseInt(process.env.UPLOAD_MAX_BYTES || '10485760', 10);
    if (buffer.length > maxBytes) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, message: `File exceeds ${maxBytes} bytes` });
    }

    // Preview headers + sample rows
    const { headers, sampleRows } = await ingestion.previewBuffer(buffer, ext);
    if (!headers || headers.length === 0) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(400).json({ success: false, message: 'Could not parse CSV headers' });
    }

    // Stage to R2
    const r2Key = `uploads/${cafeId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}-${fileName}`;
    try {
      await r2.uploadFile(buffer, r2Key, req.file.mimetype || 'text/csv');
    } catch (err) {
      try { fs.unlinkSync(filePath); } catch {}
      return res.status(503).json({ success: false, message: 'File storage unavailable, please retry' });
    }
    try { fs.unlinkSync(filePath); } catch {}

    // Detect format
    let posType, columnMapping, itemsMode;
    if (ingestion.isYocoFormat(headers)) {
      const y = ingestion.yocoMapping();
      posType = 'yoco';
      columnMapping = y.mapping;
      itemsMode = y.itemsMode;
    } else {
      posType = 'wizard';
      // Try cafe-saved mapping first
      const cafe = await Cafe.findById(cafeId).lean();
      if (cafe?.savedColumnMapping) {
        const saved = cafe.savedColumnMapping;
        columnMapping = { ...saved };
        delete columnMapping.itemsMode;
        itemsMode = saved.itemsMode || 'packed';
      } else {
        const proposal = await proposeColumnMapping(headers, sampleRows);
        columnMapping = proposal.mapping;
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

    const hasRequiredMapping = REQUIRED_UPLOAD_MAPPING.every((field) => Boolean(columnMapping?.[field]));

    return res.status(200).json({
      success: true,
      uploadId: uploadDoc._id,
      posType,
      columnMapping,
      itemsMode,
      headers,
      preview: sampleRows,
      needsConfirmation: posType !== 'yoco' && !hasRequiredMapping,
    });
  } catch (error) {
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
    const daysDiff =
      Math.max((lastDate - firstDate) / (1000 * 60 * 60 * 24), 1);
    const avgDailyRevenue = totalRevenue / daysDiff;

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

module.exports = { upload, getTransactions, getStats };
