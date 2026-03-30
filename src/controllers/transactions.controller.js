const fs = require('fs');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const { ingestFile } = require('../services/ingestion.service');

const upload = async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const cafeId = req.user.cafeId;
    const filePath = req.file.path;

    const result = await ingestFile(filePath, cafeId);

    // Clean up uploaded file
    try { fs.unlinkSync(filePath); } catch (_) {}

    // Update cafe metadata
    await Cafe.findByIdAndUpdate(cafeId, {
      $set: { dataUploaded: true, lastSyncAt: new Date() },
    });

    // Get date range for response
    const dateRange = await Transaction.aggregate([
      { $match: { cafeId: require('mongoose').Types.ObjectId.createFromHexString(cafeId) } },
      { $group: { _id: null, firstDate: { $min: '$date' }, lastDate: { $max: '$date' } } },
    ]);

    return res.status(200).json({
      success: true,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors,
      total: result.imported + result.skipped + result.errors,
      firstDate: dateRange[0]?.firstDate || null,
      lastDate: dateRange[0]?.lastDate || null,
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
