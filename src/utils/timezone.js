// Cafe-local date arithmetic: the one home of the zoned helpers (BE-11-T05 moves every caller onto it).
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.

const DEFAULT_TIMEZONE = 'Africa/Johannesburg';
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const safeTimezone = (timezone) => {
  const candidate = String(timezone || DEFAULT_TIMEZONE);
  try {
    Intl.DateTimeFormat('en-ZA', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return DEFAULT_TIMEZONE;
  }
};

const getTimeZoneOffsetMs = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: safeTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  const asUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return asUtc + date.getUTCMilliseconds() - date.getTime();
};

const zonedDateTimeToUtc = (
  { year, month, day, hour = 0, minute = 0, second = 0, ms = 0 },
  timezone
) => {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const firstOffset = getTimeZoneOffsetMs(new Date(utcGuess), timezone);
  const firstUtc = utcGuess - firstOffset;
  const secondOffset = getTimeZoneOffsetMs(new Date(firstUtc), timezone);
  return new Date(utcGuess - secondOffset);
};

const getZonedDateParts = (date, timezone) => {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: safeTimezone(timezone),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(parsed);
  const values = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
};

const dateOnlyParts = (value, timezone) => {
  const match = typeof value === 'string' ? String(value).trim().match(DATE_ONLY_RE) : null;
  if (match) {
    const parts = {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
    const check = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    if (
      check.getUTCFullYear() !== parts.year ||
      check.getUTCMonth() !== parts.month - 1 ||
      check.getUTCDate() !== parts.day
    ) return null;
    return parts;
  }
  const parts = getZonedDateParts(value, timezone);
  return parts && { year: parts.year, month: parts.month, day: parts.day };
};

const addDatePartsDays = (parts, days) => {
  const cursor = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  cursor.setUTCDate(cursor.getUTCDate() + days);
  return {
    year: cursor.getUTCFullYear(),
    month: cursor.getUTCMonth() + 1,
    day: cursor.getUTCDate(),
  };
};

const zonedDayStart = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(parts, timezone);
};

const zonedDayEnd = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(
    { ...parts, hour: 23, minute: 59, second: 59, ms: 999 },
    timezone
  );
};

const addZonedDays = (value, days, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return zonedDateTimeToUtc(addDatePartsDays(parts, days), timezone);
};

const zonedDayOrdinal = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / 86400000);
};

const zonedDateKey = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

const zonedDayOfWeek = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
};

const processLocalCalendarDate = (value, timezone = DEFAULT_TIMEZONE) => {
  const parts = dateOnlyParts(value, timezone);
  if (!parts) return null;
  return new Date(parts.year, parts.month - 1, parts.day, 12, 0, 0, 0);
};

module.exports = {
  DEFAULT_TIMEZONE, safeTimezone, zonedDateTimeToUtc, getZonedDateParts, zonedDayStart, zonedDayEnd,
  addZonedDays, zonedDayOrdinal, zonedDateKey, zonedDayOfWeek, processLocalCalendarDate,
};
