const mongoose = require('mongoose');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const { isWeekdayHourOpen } = require('../utils/tradingHours');

const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const safeTimezone = (timezone) => {
  try {
    Intl.DateTimeFormat('en-ZA', { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

const getCafeTimezone = async (cafeId) => {
  const cafe = await Cafe.findById(cafeId).select('timezone').lean();
  return safeTimezone(cafe?.timezone || DEFAULT_TIMEZONE);
};

const getTimeZoneOffsetMs = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc + date.getUTCMilliseconds() - date.getTime();
};

const zonedTimeToUtc = ({ year, month, day, hour = 0, minute = 0, second = 0, ms = 0 }, timezone) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timezone);
  return new Date(utcGuess - secondOffset);
};

const getLocalDateParts = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
};

const addLocalDays = ({ year, month, day }, days) => {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
};

const localDayBoundaryUtc = (date, timezone, boundary = 'start', deltaDays = 0) => {
  const parts = addLocalDays(getLocalDateParts(date, timezone), deltaDays);
  return zonedTimeToUtc({
    ...parts,
    hour: boundary === 'end' ? 23 : 0,
    minute: boundary === 'end' ? 59 : 0,
    second: boundary === 'end' ? 59 : 0,
    ms: boundary === 'end' ? 999 : 0,
  }, timezone);
};

const localDayOrdinal = (date, timezone) => {
  const parts = getLocalDateParts(date, timezone);
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / MS_PER_DAY);
};

const inclusiveLocalDayCount = (startDate, endDate, timezone) =>
  Math.max(localDayOrdinal(endDate, timezone) - localDayOrdinal(startDate, timezone) + 1, 1);

const parseDateBoundary = (value, timezone, boundary = 'start') => {
  if (!value) return null;
  const str = String(value).trim();
  const match = str.match(DATE_ONLY_RE);

  if (match) {
    return zonedTimeToUtc({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: boundary === 'end' ? 23 : 0,
      minute: boundary === 'end' ? 59 : 0,
      second: boundary === 'end' ? 59 : 0,
      ms: boundary === 'end' ? 999 : 0,
    }, timezone);
  }

  const parsed = new Date(str);
  if (Number.isNaN(parsed.getTime())) {
    const error = new Error(`Invalid ${boundary === 'end' ? 'endDate' : 'startDate'}`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
};

const buildDateMatch = (query, timezone) => {
  const dateMatch = {};
  if (query.startDate) dateMatch.$gte = parseDateBoundary(query.startDate, timezone, 'start');
  if (query.endDate) dateMatch.$lte = parseDateBoundary(query.endDate, timezone, 'end');
  return dateMatch;
};

const dateToString = (format, timezone) => ({
  $dateToString: {
    format,
    date: '$date',
    timezone,
  },
});

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
    const endDate = req.query.endDate ? parseDateBoundary(req.query.endDate, timezone, 'end') : new Date();
    const startDate = req.query.startDate
      ? parseDateBoundary(req.query.startDate, timezone, 'start')
      : new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);

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
        startDate: req.query.startDate || null,
        endDate: req.query.endDate || null,
        summary,
        period,
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
    const timezone = await getCafeTimezone(cafeId);

    const { startDate, endDate } = req.query;
    const dateMatch = buildDateMatch(req.query, timezone);
    const matchStage = {
      cafeId: cafeObjectId,
      status: 'approved',
      ...(Object.keys(dateMatch).length > 0 && { date: dateMatch }),
    };

    // Get the date range for the dataset
    const rangeResult = await Transaction.aggregate([
      { $match: matchStage },
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
        data: [],
        risingItems: [],
        decliningItems: [],
        meta: {
          startDate: startDate || null,
          endDate: endDate || null,
          risingItems: [],
          decliningItems: [],
        },
      });
    }

    const { minDate, maxDate } = rangeResult[0];
    const rangeStart = dateMatch.$gte || minDate;
    const rangeEnd = dateMatch.$lte || maxDate;
    const totalDays = inclusiveLocalDayCount(rangeStart, rangeEnd, timezone);

    // Top 20 items overall
    const itemsPipeline = [
      { $match: matchStage },
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

    // Trend: latest 7 local trading days in the selected data vs previous 7 days.
    const trendEnd = localDayBoundaryUtc(maxDate, timezone, 'end');
    const currentStart = localDayBoundaryUtc(maxDate, timezone, 'start', -6);
    const previousStart = localDayBoundaryUtc(maxDate, timezone, 'start', -13);

    const trendPipeline = [
      {
        $match: {
          cafeId: cafeObjectId,
          status: 'approved',
          date: { $gte: previousStart, $lte: trendEnd },
        },
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: {
            name: '$items.name',
            period: {
              $cond: [{ $gte: ['$date', currentStart] }, 'current', 'previous'],
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
      .filter((item) => item.trend > 0)
      .sort((a, b) => b.trend - a.trend)
      .slice(0, 5)
      .map(({ name, trend }) => ({ name, trend }));

    const decliningItems = [...allItemTrends]
      .filter((item) => item.trend < 0)
      .sort((a, b) => a.trend - b.trend)
      .slice(0, 5)
      .map(({ name, trend }) => ({ name, trend }));

    return res.status(200).json({
      success: true,
      items: itemsWithTrend,
      data: itemsWithTrend,
      meta: {
        startDate: startDate || null,
        endDate: endDate || null,
        risingItems,
        decliningItems,
      },
    });
  } catch (error) {
    next(error);
  }
};

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

    const { startDate, endDate } = req.query;
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
        startDate: startDate || null,
        endDate: endDate || null,
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

    const { startDate, endDate } = req.query;
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
        meta: { startDate: startDate || null, endDate: endDate || null },
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
      meta: { startDate: startDate || null, endDate: endDate || null },
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
    const { startDate, endDate } = req.query;
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
      meta: { startDate: startDate || null, endDate: endDate || null },
    });
  } catch (error) {
    // If $sortArray is not available (older MongoDB), fall back to JS-side pair generation
    if (error.message && error.message.includes('sortArray')) {
      try {
        const cafeId = req.user.cafeId;
        const timezone = await getCafeTimezone(cafeId);
        const { startDate, endDate } = req.query;
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
          .lean();

        const pairCounts = {};
        for (const tx of transactions) {
          const names = [...new Set(tx.items.map((i) => i.name))].sort();
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
          meta: { startDate: startDate || null, endDate: endDate || null },
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
