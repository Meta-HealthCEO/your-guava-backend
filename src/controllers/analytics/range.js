// Date ranges for analytics: cafe timezone, local day boundaries and the range meta (the zoned copies go in BE-11-T05).
// Moved from analytics.controller.js by BE-11-T04; behaviour unchanged.
const Cafe = require('../../models/Cafe.model');

const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_ANALYTICS_RANGE_DAYS = 30;
const MAX_ANALYTICS_RANGE_DAYS = 1830;

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
    const nominal = new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    ));
    if (
      nominal.getUTCFullYear() !== Number(match[1]) ||
      nominal.getUTCMonth() !== Number(match[2]) - 1 ||
      nominal.getUTCDate() !== Number(match[3])
    ) {
      const error = new Error(`Invalid ${boundary === 'end' ? 'endDate' : 'startDate'}`);
      error.statusCode = 400;
      throw error;
    }
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

const assertDateRange = (startDate, endDate, timezone) => {
  if (startDate && endDate && startDate > endDate) {
    const error = new Error('startDate must be on or before endDate');
    error.statusCode = 400;
    throw error;
  }
  if (
    startDate &&
    endDate &&
    inclusiveLocalDayCount(startDate, endDate, timezone) > MAX_ANALYTICS_RANGE_DAYS
  ) {
    const error = new Error(`Analytics ranges cannot exceed ${MAX_ANALYTICS_RANGE_DAYS} days`);
    error.statusCode = 400;
    throw error;
  }
};

const buildDateMatch = (query, timezone) => {
  const endDate = query.endDate
    ? parseDateBoundary(query.endDate, timezone, 'end')
    : new Date();
  const startDate = query.startDate
    ? parseDateBoundary(query.startDate, timezone, 'start')
    : localDayBoundaryUtc(endDate, timezone, 'start', -(DEFAULT_ANALYTICS_RANGE_DAYS - 1));
  assertDateRange(startDate, endDate, timezone);
  return { $gte: startDate, $lte: endDate };
};

const analyticsRangeMeta = (query, dateMatch) => ({
  startDate: query.startDate || null,
  endDate: query.endDate || null,
  effectiveStartDate: dateMatch.$gte.toISOString(),
  effectiveEndDate: dateMatch.$lte.toISOString(),
  defaultWindowDays: DEFAULT_ANALYTICS_RANGE_DAYS,
  defaultedStartDate: !query.startDate,
  defaultedEndDate: !query.endDate,
});

const dateToString = (format, timezone) => ({
  $dateToString: {
    format,
    date: '$date',
    timezone,
  },
});

module.exports = {
  DEFAULT_ANALYTICS_RANGE_DAYS, MAX_ANALYTICS_RANGE_DAYS, safeTimezone, getCafeTimezone, localDayBoundaryUtc, inclusiveLocalDayCount,
  parseDateBoundary, buildDateMatch, analyticsRangeMeta, dateToString,
};
