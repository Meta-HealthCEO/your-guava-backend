const mongoose = require('mongoose');
const Transaction = require('../models/Transaction.model');
const Forecast = require('../models/Forecast.model');

/**
 * GET /api/analytics/revenue
 * Revenue analytics grouped by period (daily/weekly/monthly)
 */
const getRevenue = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);

    const { period = 'daily' } = req.query;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : new Date();
    const startDate = req.query.startDate
      ? new Date(req.query.startDate)
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Build date grouping expression based on period
    let dateGroup;
    if (period === 'weekly') {
      dateGroup = {
        $dateToString: {
          format: '%G-W%V',
          date: '$date',
        },
      };
    } else if (period === 'monthly') {
      dateGroup = {
        $dateToString: {
          format: '%Y-%m',
          date: '$date',
        },
      };
    } else {
      // daily (default)
      dateGroup = {
        $dateToString: {
          format: '%Y-%m-%d',
          date: '$date',
        },
      };
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
    const periodLength = endDate.getTime() - startDate.getTime();
    const prevStartDate = new Date(startDate.getTime() - periodLength);
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

    return res.status(200).json({
      success: true,
      data,
      summary: {
        totalRevenue: parseFloat(totalRevenue.toFixed(2)),
        avgDailyRevenue: parseFloat(avgDailyRevenue.toFixed(2)),
        bestDay,
        worstDay,
        trend,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/items
 * Item performance with trends
 */
const getItems = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);

    // Get the date range for the dataset
    const rangeResult = await Transaction.aggregate([
      { $match: { cafeId: cafeObjectId, status: 'approved' } },
      {
        $group: {
          _id: null,
          minDate: { $min: '$date' },
          maxDate: { $max: '$date' },
        },
      },
    ]);

    if (rangeResult.length === 0) {
      return res.status(200).json({
        success: true,
        items: [],
        risingItems: [],
        decliningItems: [],
      });
    }

    const { minDate, maxDate } = rangeResult[0];
    const totalDays = Math.max(
      (maxDate.getTime() - minDate.getTime()) / (1000 * 60 * 60 * 24),
      1
    );

    // Top 20 items overall
    const itemsPipeline = [
      { $match: { cafeId: cafeObjectId, status: 'approved' } },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.name',
          totalQty: { $sum: '$items.quantity' },
          totalRevenue: {
            $sum: { $multiply: ['$items.quantity', { $ifNull: ['$items.unitPrice', 0] }] },
          },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          name: '$_id',
          totalQty: 1,
          totalRevenue: { $round: ['$totalRevenue', 2] },
          avgPerDay: { $round: [{ $divide: ['$totalQty', totalDays] }, 1] },
        },
      },
    ];

    const items = await Transaction.aggregate(itemsPipeline);

    // Trend: last 7 days vs previous 7 days
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const trendPipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: fourteenDaysAgo, $lte: now },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            name: '$items.name',
            period: {
              $cond: [{ $gte: ['$date', sevenDaysAgo] }, 'current', 'previous'],
            },
          },
          totalQty: { $sum: '$items.quantity' },
        },
      },
    ];

    const trendData = await Transaction.aggregate(trendPipeline);

    // Build trend lookup: { itemName: { current, previous } }
    const trendMap = {};
    for (const entry of trendData) {
      const name = entry._id.name;
      const period = entry._id.period;
      if (!trendMap[name]) trendMap[name] = { current: 0, previous: 0 };
      trendMap[name][period] = entry.totalQty;
    }

    // Attach trend to items
    const itemsWithTrend = items.map((item) => {
      const t = trendMap[item.name];
      let trend = 0;
      if (t && t.previous > 0) {
        trend = parseFloat((((t.current - t.previous) / t.previous) * 100).toFixed(1));
      } else if (t && t.current > 0 && t.previous === 0) {
        trend = 100;
      }
      return { ...item, trend };
    });

    // Build full trend list for rising/declining (not limited to top 20)
    const allItemTrends = Object.entries(trendMap)
      .map(([name, t]) => {
        let trend = 0;
        if (t.previous > 0) {
          trend = parseFloat((((t.current - t.previous) / t.previous) * 100).toFixed(1));
        } else if (t.current > 0 && t.previous === 0) {
          trend = 100;
        }
        return { name, trend, currentQty: t.current, previousQty: t.previous };
      })
      .filter((i) => i.currentQty > 0 || i.previousQty > 0);

    const risingItems = [...allItemTrends]
      .sort((a, b) => b.trend - a.trend)
      .slice(0, 3)
      .map(({ name, trend }) => ({ name, trend }));

    const decliningItems = [...allItemTrends]
      .sort((a, b) => a.trend - b.trend)
      .slice(0, 3)
      .map(({ name, trend }) => ({ name, trend }));

    return res.status(200).json({
      success: true,
      items: itemsWithTrend,
      risingItems,
      decliningItems,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/heatmap
 * Peak hour heatmap — 7 days × 18 hours (5-22)
 */
const getHeatmap = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);

    const pipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          hour: { $gte: 5, $lte: 22 },
          dayOfWeek: { $gte: 0, $lte: 6 },
        },
      },
      {
        $group: {
          _id: {
            dayOfWeek: '$dayOfWeek',
            hour: '$hour',
          },
          revenue: { $sum: '$total' },
          transactions: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          dayOfWeek: '$_id.dayOfWeek',
          hour: '$_id.hour',
          revenue: { $round: ['$revenue', 2] },
          transactions: 1,
        },
      },
      { $sort: { dayOfWeek: 1, hour: 1 } },
    ];

    const rawData = await Transaction.aggregate(pipeline);

    // Fill in the complete 7x18 grid with zeros for missing slots
    const dataMap = {};
    for (const entry of rawData) {
      dataMap[`${entry.dayOfWeek}-${entry.hour}`] = entry;
    }

    const heatmap = [];
    for (let day = 0; day <= 6; day++) {
      for (let hour = 5; hour <= 22; hour++) {
        const key = `${day}-${hour}`;
        if (dataMap[key]) {
          heatmap.push(dataMap[key]);
        } else {
          heatmap.push({ dayOfWeek: day, hour, revenue: 0, transactions: 0 });
        }
      }
    }

    return res.status(200).json({
      success: true,
      heatmap,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/accuracy
 * Predicted vs actual for the last 30 days
 */
const getAccuracy = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    thirtyDaysAgo.setHours(0, 0, 0, 0);

    const now = new Date();
    now.setHours(23, 59, 59, 999);

    // Get forecasts for the last 30 days
    const forecasts = await Forecast.find({
      cafeId,
      date: { $gte: thirtyDaysAgo, $lte: now },
    })
      .sort({ date: 1 })
      .lean();

    if (forecasts.length === 0) {
      return res.status(200).json({
        success: true,
        data: [],
        overallAccuracy: null,
      });
    }

    // Get actual item quantities from transactions, grouped by date + item name
    const actualsPipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: thirtyDaysAgo, $lte: now },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            date: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
            name: '$items.name',
          },
          actual: { $sum: '$items.quantity' },
        },
      },
    ];

    const actualsRaw = await Transaction.aggregate(actualsPipeline);

    // Build lookup: { "2025-01-15": { "Flat White": 42, ... } }
    const actualsMap = {};
    for (const entry of actualsRaw) {
      const dateKey = entry._id.date;
      if (!actualsMap[dateKey]) actualsMap[dateKey] = {};
      actualsMap[dateKey][entry._id.name] = entry.actual;
    }

    // Join forecasts with actuals
    let totalPredicted = 0;
    let totalActual = 0;
    let totalAbsError = 0;

    const data = forecasts.map((forecast) => {
      const dateKey = new Date(forecast.date).toISOString().split('T')[0];
      const dayActuals = actualsMap[dateKey] || {};

      const items = (forecast.items || []).map((fi) => {
        const predicted = fi.predictedQty || 0;
        const actual = dayActuals[fi.itemName] || fi.actualQty || 0;

        totalPredicted += predicted;
        totalActual += actual;
        totalAbsError += Math.abs(predicted - actual);

        return {
          name: fi.itemName,
          predicted,
          actual,
        };
      });

      // Per-day accuracy: 1 - (totalAbsError / totalPredicted) for this day
      const dayPredicted = items.reduce((s, i) => s + i.predicted, 0);
      const dayAbsError = items.reduce((s, i) => s + Math.abs(i.predicted - i.actual), 0);
      const dayAccuracy =
        dayPredicted > 0
          ? parseFloat(((1 - dayAbsError / dayPredicted) * 100).toFixed(1))
          : null;

      return {
        date: dateKey,
        items,
        overallAccuracy: dayAccuracy,
      };
    });

    // Overall accuracy across all days
    const overallAccuracy =
      totalPredicted > 0
        ? parseFloat(((1 - totalAbsError / totalPredicted) * 100).toFixed(1))
        : null;

    return res.status(200).json({
      success: true,
      data,
      overallAccuracy,
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/customers
 * Customer insights from transaction data
 */
const getCustomers = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);

    const pipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
        },
      },
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalRevenue: { $sum: '$total' },
          totalItems: {
            $sum: {
              $reduce: {
                input: '$items',
                initialValue: 0,
                in: { $add: ['$$value', '$$this.quantity'] },
              },
            },
          },
          totalTip: { $sum: { $ifNull: ['$tip', 0] } },
          tippedTransactions: {
            $sum: {
              $cond: [{ $gt: [{ $ifNull: ['$tip', 0] }, 0] }, 1, 0],
            },
          },
          cashTransactions: {
            $sum: {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ['$paymentMethod', ''] },
                    regex: /cash/i,
                  },
                },
                1,
                0,
              ],
            },
          },
          cardTransactions: {
            $sum: {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ['$paymentMethod', ''] },
                    regex: /card|visa|master|tap|contactless/i,
                  },
                },
                1,
                0,
              ],
            },
          },
        },
      },
    ];

    const result = await Transaction.aggregate(pipeline);

    if (result.length === 0) {
      return res.status(200).json({
        success: true,
        insights: {
          avgTransactionValue: 0,
          avgItemsPerTransaction: 0,
          cashVsCardRatio: null,
          tippingRate: 0,
          avgTip: 0,
        },
      });
    }

    const stats = result[0];
    const avgTransactionValue =
      stats.totalTransactions > 0
        ? parseFloat((stats.totalRevenue / stats.totalTransactions).toFixed(2))
        : 0;

    const avgItemsPerTransaction =
      stats.totalTransactions > 0
        ? parseFloat((stats.totalItems / stats.totalTransactions).toFixed(1))
        : 0;

    const totalPaymentKnown = stats.cashTransactions + stats.cardTransactions;
    const cashVsCardRatio =
      totalPaymentKnown > 0
        ? {
            cash: parseFloat(((stats.cashTransactions / totalPaymentKnown) * 100).toFixed(1)),
            card: parseFloat(((stats.cardTransactions / totalPaymentKnown) * 100).toFixed(1)),
          }
        : null;

    const tippingRate =
      stats.totalTransactions > 0
        ? parseFloat(((stats.tippedTransactions / stats.totalTransactions) * 100).toFixed(1))
        : 0;

    const avgTip =
      stats.tippedTransactions > 0
        ? parseFloat((stats.totalTip / stats.tippedTransactions).toFixed(2))
        : 0;

    return res.status(200).json({
      success: true,
      insights: {
        avgTransactionValue,
        avgItemsPerTransaction,
        cashVsCardRatio,
        tippingRate,
        avgTip,
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/waste
 * Waste analytics — placeholder
 */
const getWaste = async (req, res, next) => {
  try {
    return res.status(200).json({
      success: true,
      message: 'Waste tracking coming soon',
      data: [],
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getRevenue,
  getItems,
  getHeatmap,
  getAccuracy,
  getCustomers,
  getWaste,
};
