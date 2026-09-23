const mongoose = require('mongoose');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const { isWeekdayHourOpen } = require('../utils/tradingHours');
const { safeTimezone, getCafeTimezone, buildDateMatch, analyticsRangeMeta, dateToString } = require('./analytics/range');
const { getRevenue } = require('./analytics/revenue');
const { getItems } = require('./analytics/items');

const MAX_COMBO_FALLBACK_TRANSACTIONS = 5000;
const MAX_COMBO_FALLBACK_PAIR_WORK = 100000;

/**
 * GET /api/analytics/heatmap
 * Peak hour heatmap — 7 days × 17 hours (6-22)
 */
const getHeatmap = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafeObjectId = mongoose.Types.ObjectId.createFromHexString(cafeId);
    const cafe = await Cafe.findById(cafeId).select('timezone tradingHours').lean();
    const timezone = safeTimezone(cafe?.timezone);

    const dateMatch = buildDateMatch(req.query, timezone);
    const baseMatchStage = {
      cafeId: cafeObjectId,
      status: 'approved',
      dayOfWeek: { $gte: 0, $lte: 6 },
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };
    const heatmapMatchStage = {
      ...baseMatchStage,
      hour: { $gte: 6, $lte: 22 },
    };

    const dayCountPipeline = [
      { $match: baseMatchStage },
      {
        $group: {
          _id: {
            dayOfWeek: '$dayOfWeek',
            date: dateToString('%Y-%m-%d', timezone),
          },
        },
      },
      {
        $group: {
          _id: '$_id.dayOfWeek',
          observedDays: { $sum: 1 },
        },
      },
    ];

    const hourlyTotalsPipeline = [
      { $match: heatmapMatchStage },
      {
        $group: {
          _id: {
            dayOfWeek: '$dayOfWeek',
            hour: '$hour',
          },
          totalRevenue: { $sum: '$total' },
          totalTransactions: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          dayOfWeek: '$_id.dayOfWeek',
          hour: '$_id.hour',
          totalRevenue: { $round: ['$totalRevenue', 2] },
          totalTransactions: 1,
        },
      },
      { $sort: { dayOfWeek: 1, hour: 1 } },
    ];

    const [dayCounts, rawData] = await Promise.all([
      Transaction.aggregate(dayCountPipeline),
      Transaction.aggregate(hourlyTotalsPipeline),
    ]);
    const observedDaysByWeekday = new Map(
      dayCounts.map((entry) => [entry._id, entry.observedDays])
    );

    // Fill in the complete 7x17 grid with zeros for missing slots
    const dataMap = {};
    for (const entry of rawData) {
      const observedDays = observedDaysByWeekday.get(entry.dayOfWeek) || 1;
      dataMap[`${entry.dayOfWeek}-${entry.hour}`] = {
        dayOfWeek: entry.dayOfWeek,
        hour: entry.hour,
        revenue: parseFloat((entry.totalRevenue / observedDays).toFixed(2)),
        transactions: parseFloat((entry.totalTransactions / observedDays).toFixed(1)),
        totalRevenue: entry.totalRevenue,
        totalTransactions: entry.totalTransactions,
        observedDays,
        isOpen: isWeekdayHourOpen(entry.dayOfWeek, entry.hour, cafe),
      };
    }

    const heatmap = [];
    for (let day = 0; day <= 6; day++) {
      for (let hour = 6; hour <= 22; hour++) {
        const key = `${day}-${hour}`;
        if (dataMap[key]) {
          heatmap.push(dataMap[key]);
        } else {
          heatmap.push({
            dayOfWeek: day,
            hour,
            revenue: 0,
            transactions: 0,
            totalRevenue: 0,
            totalTransactions: 0,
            observedDays: observedDaysByWeekday.get(day) || 0,
            isOpen: isWeekdayHourOpen(day, hour, cafe),
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      heatmap,
      data: heatmap,
      meta: {
        ...analyticsRangeMeta(req.query, dateMatch),
        metric: 'average_per_observed_weekday',
      },
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
    const timezone = await getCafeTimezone(cafeId);

    const dateMatch = buildDateMatch(req.query, timezone);
    const matchStage = {
      cafeId: cafeObjectId,
      status: 'approved',
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };

    const pipeline = [
      { $match: matchStage },
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
      const emptyInsights = {
        avgTransactionValue: 0,
        avgItemsPerTransaction: 0,
        cashVsCardRatio: null,
        tippingRate: 0,
        avgTip: 0,
      };
      return res.status(200).json({
        success: true,
        insights: emptyInsights,
        data: emptyInsights,
        meta: analyticsRangeMeta(req.query, dateMatch),
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

    const insights = {
      avgTransactionValue,
      avgItemsPerTransaction,
      cashVsCardRatio,
      tippingRate,
      avgTip,
    };

    return res.status(200).json({
      success: true,
      insights,
      data: insights,
      meta: analyticsRangeMeta(req.query, dateMatch),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /api/analytics/combos
 * Frequently-bought-together item pairs
 */
const getCombos = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const timezone = await getCafeTimezone(cafeId);
    const dateMatch = buildDateMatch(req.query, timezone);

    const matchStage = {
      cafeId: new mongoose.Types.ObjectId(cafeId),
      status: 'approved',
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };

    // Take the top 20 item-pair co-occurrences across all transactions with 2+ items.
    const combos = await Transaction.aggregate([
      { $match: matchStage },
      { $match: { 'items.1': { $exists: true } } },           // ≥2 items
      {
        $project: {
          itemNames: {
            $sortArray: { input: { $setUnion: ['$items.name', []] }, sortBy: 1 },
          },
        },
      },
      // Generate unordered pairs
      {
        $project: {
          pairs: {
            $reduce: {
              input: { $range: [0, { $size: '$itemNames' }] },
              initialValue: [],
              in: {
                $concatArrays: [
                  '$$value',
                  {
                    $map: {
                      input: { $range: [{ $add: ['$$this', 1] }, { $size: '$itemNames' }] },
                      as: 'j',
                      in: [
                        { $arrayElemAt: ['$itemNames', '$$this'] },
                        { $arrayElemAt: ['$itemNames', '$$j'] },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
      { $unwind: '$pairs' },
      { $group: { _id: '$pairs', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
      {
        $project: {
          _id: 0,
          pair: '$_id',
          count: 1,
        },
      },
    ]);

    return res.status(200).json({
      success: true,
      data: combos,
      meta: analyticsRangeMeta(req.query, dateMatch),
    });
  } catch (error) {
    // If $sortArray is not available (older MongoDB), fall back to JS-side pair generation
    if (error.message && error.message.includes('sortArray')) {
      try {
        const cafeId = req.user.cafeId;
        const timezone = await getCafeTimezone(cafeId);
        const dateMatch = buildDateMatch(req.query, timezone);

        const matchStage = {
          cafeId: new mongoose.Types.ObjectId(cafeId),
          status: 'approved',
          ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
        };

        const transactions = await Transaction.find({
          ...matchStage,
          'items.1': { $exists: true },
        })
          .select('items.name')
          .sort({ date: -1, _id: -1 })
          .limit(MAX_COMBO_FALLBACK_TRANSACTIONS + 1)
          .lean();

        if (transactions.length > MAX_COMBO_FALLBACK_TRANSACTIONS) {
          const capacityError = new Error(
            `Combo analytics fallback is limited to ${MAX_COMBO_FALLBACK_TRANSACTIONS} transactions; narrow the date range`
          );
          capacityError.statusCode = 503;
          capacityError.details = { code: 'COMBO_FALLBACK_RANGE_TOO_LARGE' };
          throw capacityError;
        }

        const pairCounts = {};
        let pairWork = 0;
        for (const tx of transactions) {
          const names = [...new Set(tx.items.map((i) => i.name))].sort();
          pairWork += (names.length * (names.length - 1)) / 2;
          if (pairWork > MAX_COMBO_FALLBACK_PAIR_WORK) {
            const capacityError = new Error(
              `Combo analytics fallback exceeds its ${MAX_COMBO_FALLBACK_PAIR_WORK}-pair work budget; narrow the date range`
            );
            capacityError.statusCode = 503;
            capacityError.details = { code: 'COMBO_FALLBACK_WORK_LIMIT' };
            throw capacityError;
          }
          for (let i = 0; i < names.length; i++) {
            for (let j = i + 1; j < names.length; j++) {
              const key = JSON.stringify([names[i], names[j]]);
              pairCounts[key] = (pairCounts[key] || 0) + 1;
            }
          }
        }

        const combos = Object.entries(pairCounts)
          .map(([key, count]) => ({ pair: JSON.parse(key), count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 20);

        return res.status(200).json({
          success: true,
          data: combos,
          meta: analyticsRangeMeta(req.query, dateMatch),
        });
      } catch (fallbackError) {
        next(fallbackError);
      }
    } else {
      next(error);
    }
  }
};

module.exports = {
  getRevenue,
  getItems,
  getHeatmap,
  getCustomers,
  getCombos,
};
