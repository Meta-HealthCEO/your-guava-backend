// GET /analytics/revenue.
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const mongoose = require('mongoose');
const Transaction = require('../../models/Transaction.model');
const {
  getCafeTimezone, buildDateMatch, dateToString, inclusiveLocalDayCount, localDayBoundaryUtc, analyticsRangeMeta,
} = require('./range');

/**
 * GET /api/analytics/revenue
 * Revenue analytics grouped by period (daily/weekly/monthly)
 */
const getRevenue = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const timezone = await getCafeTimezone(cafeId);

    const { period = 'daily' } = req.query;
    const dateMatch = buildDateMatch(req.query, timezone);
    const startDate = dateMatch.$gte;
    const endDate = dateMatch.$lte;

    // Build date grouping expression based on period
    let dateGroup;
    if (period === 'weekly') {
      dateGroup = dateToString('%G-W%V', timezone);
    } else if (period === 'monthly') {
      dateGroup = dateToString('%Y-%m', timezone);
    } else {
      // daily (default)
      dateGroup = dateToString('%Y-%m-%d', timezone);
    }

    const pipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: dateGroup,
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: '$_id',
          revenue: { $round: ['$revenue', 2] },
          transactions: 1,
        },
      },
    ];

    const data = await Transaction.aggregate(pipeline);

    // Calculate summary stats
    const totalRevenue = data.reduce((sum, d) => sum + d.revenue, 0);
    const avgDailyRevenue =
      data.length > 0 ? totalRevenue / data.length : 0;

    let bestDay = null;
    let worstDay = null;
    if (data.length > 0) {
      bestDay = data.reduce((best, d) => (d.revenue > best.revenue ? d : best), data[0]);
      worstDay = data.reduce((worst, d) => (d.revenue < worst.revenue ? d : worst), data[0]);
    }

    // Calculate trend: compare current period total vs previous period of same length
    const rangeDays = inclusiveLocalDayCount(startDate, endDate, timezone);
    const prevStartDate = localDayBoundaryUtc(startDate, timezone, 'start', -rangeDays);
    const prevEndDate = new Date(startDate.getTime() - 1);

    const prevPipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: prevStartDate, $lte: prevEndDate },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: '$total' },
        },
      },
    ];

    const prevData = await Transaction.aggregate(prevPipeline);
    const prevRevenue = prevData.length > 0 ? prevData[0].revenue : 0;

    let trend = 0;
    if (prevRevenue > 0) {
      trend = parseFloat((((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1));
    }

    const summary = {
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      avgDailyRevenue: parseFloat(avgDailyRevenue.toFixed(2)),
      bestDay,
      worstDay,
      trend,
    };

    return res.status(200).json({
      success: true,
      data,
      summary,
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch),
        summary,
        period,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getRevenue,
};
