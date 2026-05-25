const Event = require('../models/Event.model');
const Forecast = require('../models/Forecast.model');
const Transaction = require('../models/Transaction.model');
const Cafe = require('../models/Cafe.model');
const { getForecastSettings, eventImpactPct } = require('../services/forecastFactors.service');

const invalidatePlanningForecastsFrom = async (cafeId, date) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  if (start < today) start.setTime(today.getTime());

  await Forecast.deleteMany({ cafeId, date: { $gte: start } });
};

const parseImpactPct = (impactPct) => {
  if (impactPct === undefined || impactPct === null || impactPct === '') return undefined;
  const parsed = Number(impactPct);
  if (!Number.isFinite(parsed) || parsed < -90 || parsed > 200) {
    const error = new Error('impactPct must be between -90 and 200');
    error.statusCode = 400;
    throw error;
  }
  return Math.round(parsed * 10) / 10;
};

const ALLOWED_EVENT_TYPES = ['event', 'closure', 'partial_closure'];
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseEventType = (type) => {
  if (type === undefined || type === null || type === '') return undefined;
  if (!ALLOWED_EVENT_TYPES.includes(type)) {
    const error = new Error(`type must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`);
    error.statusCode = 400;
    throw error;
  }
  return type;
};

const parseClosureWindow = (type, closureWindow) => {
  if (type !== 'partial_closure') return undefined;
  if (!closureWindow || typeof closureWindow !== 'object') {
    const error = new Error('partial_closure requires closureWindow with startTime and endTime');
    error.statusCode = 400;
    throw error;
  }
  const { startTime, endTime } = closureWindow;
  if (!TIME_RE.test(startTime || '') || !TIME_RE.test(endTime || '')) {
    const error = new Error('closureWindow.startTime and closureWindow.endTime must be HH:mm');
    error.statusCode = 400;
    throw error;
  }
  return { startTime, endTime };
};

const dateOnly = (value) => {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
};

const dateKey = (date) => date.toISOString().slice(0, 10);

const pctChange = (actual, baseline) => {
  if (!Number.isFinite(actual) || !Number.isFinite(baseline) || baseline <= 0) return null;
  return Number((((actual - baseline) / baseline) * 100).toFixed(1));
};

const getDailySales = async (cafeId, start, end) => Transaction.aggregate([
  {
    $match: {
      cafeId,
      status: 'approved',
      date: { $gte: start, $lt: end },
    },
  },
  {
    $group: {
      _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
      revenue: { $sum: '$total' },
      transactions: { $sum: 1 },
    },
  },
  { $sort: { _id: 1 } },
]);

const eventEffects = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const cafe = await Cafe.findById(cafeId).lean();
    if (!cafe) return res.status(404).json({ success: false, message: 'Cafe not found' });

    const today = dateOnly(new Date());
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 30, 100));
    const baselineWeeks = Math.max(3, Math.min(Number(req.query.baselineWeeks) || 8, 16));
    const to = req.query.to ? dateOnly(req.query.to) : today;
    const from = req.query.from
      ? dateOnly(req.query.from)
      : addDays(to, -365);
    const settings = getForecastSettings(cafe);

    const events = await Event.find({
      cafeId,
      date: { $gte: from, $lte: to },
    })
      .sort({ date: -1 })
      .limit(limit)
      .lean();

    if (events.length === 0) {
      return res.status(200).json({
        success: true,
        effects: [],
        summary: {
          eventsAnalyzed: 0,
          avgRevenueImpactPct: null,
          aboveExpected: 0,
          belowExpected: 0,
          insufficientData: 0,
        },
      });
    }

    const earliestBaselineStart = addDays(dateOnly(events[events.length - 1].date), -baselineWeeks * 7);
    const eventEnd = addDays(dateOnly(events[0].date), 1);

    const [dailySales, eventDates] = await Promise.all([
      getDailySales(cafe._id, earliestBaselineStart, eventEnd),
      Event.find({ cafeId, date: { $gte: earliestBaselineStart, $lt: eventEnd } }).select('date').lean(),
    ]);

    const salesByDate = new Map(dailySales.map((row) => [row._id, row]));
    const eventDateKeys = new Set(eventDates.map((event) => dateKey(event.date)));

    const effects = events.map((event) => {
      const eventDate = dateOnly(event.date);
      const key = dateKey(eventDate);
      const eventSales = salesByDate.get(key) || { revenue: 0, transactions: 0 };
      const baselineStart = addDays(eventDate, -baselineWeeks * 7);
      const eventWeekday = eventDate.getUTCDay();

      const comparableDays = dailySales.filter((row) => {
        const rowDate = dateOnly(row._id);
        const rowKey = row._id;
        return rowDate >= baselineStart &&
          rowDate < eventDate &&
          rowDate.getUTCDay() === eventWeekday &&
          !eventDateKeys.has(rowKey) &&
          row.revenue > 0;
      });

      const baselineDayCount = comparableDays.length;
      const baselineRevenue = baselineDayCount > 0
        ? comparableDays.reduce((sum, row) => sum + (row.revenue || 0), 0) / baselineDayCount
        : 0;
      const baselineTransactions = baselineDayCount > 0
        ? comparableDays.reduce((sum, row) => sum + (row.transactions || 0), 0) / baselineDayCount
        : 0;
      const actualRevenue = Number((eventSales.revenue || 0).toFixed(2));
      const actualTransactions = eventSales.transactions || 0;
      const revenueImpactPct = pctChange(actualRevenue, baselineRevenue);
      const transactionImpactPct = pctChange(actualTransactions, baselineTransactions);
      const expectedImpactPct = eventImpactPct(event, settings.events);
      const vsExpectedPct = revenueImpactPct == null
        ? null
        : Number((revenueImpactPct - expectedImpactPct).toFixed(1));

      return {
        eventId: event._id,
        name: event.name,
        date: event.date,
        impact: event.impact,
        expectedImpactPct,
        actualRevenue,
        actualTransactions,
        baselineRevenue: Number(baselineRevenue.toFixed(2)),
        baselineTransactions: Number(baselineTransactions.toFixed(1)),
        baselineDayCount,
        revenueImpactPct,
        transactionImpactPct,
        vsExpectedPct,
        confidence: actualTransactions === 0 || baselineDayCount === 0
          ? 'none'
          : baselineDayCount < 4
            ? 'low'
            : baselineDayCount < 7
              ? 'medium'
              : 'high',
      };
    });

    const measured = effects.filter((effect) => effect.revenueImpactPct != null);
    const avgRevenueImpactPct = measured.length > 0
      ? Number((measured.reduce((sum, effect) => sum + effect.revenueImpactPct, 0) / measured.length).toFixed(1))
      : null;

    return res.status(200).json({
      success: true,
      effects,
      summary: {
        eventsAnalyzed: effects.length,
        avgRevenueImpactPct,
        aboveExpected: measured.filter((effect) => effect.vsExpectedPct > 0).length,
        belowExpected: measured.filter((effect) => effect.vsExpectedPct < 0).length,
        insufficientData: effects.filter((effect) => effect.confidence === 'none').length,
      },
    });
  } catch (error) {
    next(error);
  }
};

const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { from, to } = req.query;

    const filter = { cafeId };

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    } else {
      // Default: show events from today onwards
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      filter.date = { $gte: today };
    }

    const events = await Event.find(filter).sort({ date: 1 }).lean();
    return res.status(200).json({ success: true, events });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { name, date, impact, impactPct, notes, recurring, type, closureWindow } = req.body;

    if (!name || !date) {
      return res.status(400).json({ success: false, message: 'name and date are required' });
    }

    const parsedType = parseEventType(type) || 'event';
    const parsedClosure = parseClosureWindow(parsedType, closureWindow);

    const event = await Event.create({
      cafeId,
      name,
      date: new Date(date),
      type: parsedType,
      closureWindow: parsedClosure,
      impact: impact || 'medium',
      impactPct: parseImpactPct(impactPct),
      notes,
      recurring: recurring || false,
    });
    await invalidatePlanningForecastsFrom(cafeId, event.date);

    return res.status(201).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;
    const { name, date, impact, impactPct, notes, recurring, type, closureWindow } = req.body;

    const existing = await Event.findOne({ _id: id, cafeId }).lean();
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    const update = {};
    if (name !== undefined) update.name = name;
    if (date !== undefined) update.date = new Date(date);
    if (impact !== undefined) update.impact = impact;
    if (notes !== undefined) update.notes = notes;
    if (recurring !== undefined) update.recurring = recurring;
    if (impactPct !== undefined) update.impactPct = parseImpactPct(impactPct);

    if (type !== undefined) {
      const parsedType = parseEventType(type);
      update.type = parsedType;
      const effectiveType = parsedType || existing.type || 'event';
      if (effectiveType === 'partial_closure') {
        update.closureWindow = parseClosureWindow(effectiveType, closureWindow ?? existing.closureWindow);
      } else {
        update.closureWindow = undefined;
      }
    } else if (closureWindow !== undefined) {
      update.closureWindow = parseClosureWindow(existing.type || 'event', closureWindow);
    }

    const event = await Event.findOneAndUpdate(
      { _id: id, cafeId },
      { $set: update },
      { new: true, runValidators: true }
    );
    const invalidateFrom = date !== undefined && new Date(date) < existing.date
      ? new Date(date)
      : existing.date;
    await invalidatePlanningForecastsFrom(cafeId, invalidateFrom);

    return res.status(200).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const event = await Event.findOneAndDelete({ _id: id, cafeId });

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }
    await invalidatePlanningForecastsFrom(cafeId, event.date);

    return res.status(200).json({ success: true, message: 'Event deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, update, remove, eventEffects };
