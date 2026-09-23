// Transaction date and time parsing in the cafe timezone, and the date-range error.
// Moved from parser.service.js by BE-11-T01; behaviour unchanged.
const { DEFAULT_TIMEZONE, getZonedDateParts, zonedDateTimeToUtc, zonedDayStart, addZonedDays, zonedDateKey } = require('../../utils/timezone');
const { parserLimits } = require('./limits');
const { excelSerialDateToDate } = require('./xlsx');

const parseTimeParts = (timeStr) => {
  if (!timeStr) return null;
  if (timeStr instanceof Date) {
    return {
      hours: timeStr.getUTCHours(),
      minutes: timeStr.getUTCMinutes(),
      seconds: timeStr.getUTCSeconds(),
    };
  }
  if (typeof timeStr === 'number') {
    if (!Number.isFinite(timeStr)) return null;
    const dayFraction = ((timeStr % 1) + 1) % 1;
    const totalSeconds = Math.round(dayFraction * 24 * 60 * 60);
    return {
      hours: Math.floor(totalSeconds / 3600) % 24,
      minutes: Math.floor((totalSeconds % 3600) / 60),
      seconds: totalSeconds % 60,
    };
  }
  const match = String(timeStr).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const parts = {
    hours: parseInt(match[1], 10),
    minutes: parseInt(match[2], 10),
    seconds: parseInt(match[3] || '0', 10),
  };
  if (
    parts.hours < 0 || parts.hours > 23 ||
    parts.minutes < 0 || parts.minutes > 59 ||
    parts.seconds < 0 || parts.seconds > 59
  ) {
    return null;
  }
  return parts;
};

const applyTimeParts = (date, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const hasExplicitTime = timeStr != null && String(timeStr).trim() !== '';
  if (!hasExplicitTime) return date;
  const time = parseTimeParts(timeStr);
  if (!time) return null;
  const localDate = getZonedDateParts(date, timezone);
  if (!localDate) return null;
  return zonedDateTimeToUtc({
    year: localDate.year,
    month: localDate.month,
    day: localDate.day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

const dateFromParts = (year, month, day, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  const time = timeStr != null && String(timeStr).trim() !== ''
    ? parseTimeParts(timeStr)
    : { hours: 0, minutes: 0, seconds: 0 };
  if (!time) return null;
  return zonedDateTimeToUtc({
    year,
    month,
    day,
    hour: time.hours,
    minute: time.minutes,
    second: time.seconds,
  }, timezone);
};

// A cell can carry its own time -- "2026-09-03 23:30", "03/09/2026T14:30:00".
// The anchor after the time is what keeps an offset-qualified timestamp out:
// "...T23:30:00Z" and "...+02:00" do not match, and go to `new Date`, which is
// the right reader for a string that already states its zone.
const COMBINED_DATE_TIME_RE =
  /^(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})[T\s]+(\d{1,2}:\d{2}(?::\d{2})?)$/;
// Two-digit years are day-first too, like every other date an SA till writes.
// The pivot: 70-99 is the 1900s, 00-69 the 2000s, which covers every export
// that could plausibly be trading history without reaching a year that has not
// happened. Both ends are refused anyway by the min-year and future-day bounds.
const TWO_DIGIT_YEAR_PIVOT = 70;

const expandTwoDigitYear = (shortYear) =>
  (shortYear >= TWO_DIGIT_YEAR_PIVOT ? 1900 : 2000) + shortYear;

const parseDateString = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  const value = String(dateStr).trim();

  // A combined cell used to reach `new Date`, which resolves a naive local
  // string in the NODE process timezone rather than the cafe's, and
  // applyTimeParts then only re-read the resulting instant -- so the process
  // reading was already baked in. On a UTC host that stamped every sale after
  // 22:00 cafe-local with the next trading day and shifted every hour by two.
  // Splitting the cell and building the instant from its parts puts it in the
  // cafe zone, exactly as a separate Time column already does.
  const combined = value.match(COMBINED_DATE_TIME_RE);
  const datePart = combined ? combined[1] : value;
  // A mapped Time column still wins: it is the operator's explicit choice.
  const time = timeStr != null && String(timeStr).trim() !== '' ? timeStr : combined?.[2];

  let match = datePart.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[1], 10),
      parseInt(match[2], 10),
      parseInt(match[3], 10),
      time,
      timezone
    );
  }

  match = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    return dateFromParts(
      parseInt(match[3], 10),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      time,
      timezone
    );
  }

  // Nothing matched a two-digit year, so "03/09/26" fell through to V8's
  // month-first reading and landed on 9 March instead of 3 September, while
  // "13/09/26" was discarded as unparseable. Days 1-12 moved month in silence
  // and days 13-31 vanished, on a till doing nothing more exotic than using a
  // short date format.
  match = datePart.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (match) {
    return dateFromParts(
      expandTwoDigitYear(parseInt(match[3], 10)),
      parseInt(match[2], 10),
      parseInt(match[1], 10),
      time,
      timezone
    );
  }

  // A bare number is not a date, whatever `new Date` makes of it: it reads "0"
  // as the year 2000 and "45900" as the year 45899. Both passed the minimum-year
  // floor, and one junk cell then widened the file's span far enough to have the
  // whole upload refused for a date range the owner's three-day file never had.
  if (/^\d+$/.test(value)) return null;

  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return null;
  return applyTimeParts(parsed, timeStr, timezone);
};

const parseDate = (dateStr, timeStr, timezone = DEFAULT_TIMEZONE) => {
  if (!dateStr) return null;
  if (dateStr instanceof Date) {
    const source = new Date(dateStr);
    const sourceTime = timeStr != null && String(timeStr).trim() !== ''
      ? timeStr
      : `${source.getUTCHours()}:${String(source.getUTCMinutes()).padStart(2, '0')}:${String(source.getUTCSeconds()).padStart(2, '0')}`;
    const withTime = dateFromParts(
      source.getUTCFullYear(),
      source.getUTCMonth() + 1,
      source.getUTCDate(),
      sourceTime,
      timezone
    );
    return !withTime || isNaN(withTime.getTime()) ? null : withTime;
  }
  if (typeof dateStr === 'number') {
    const date = excelSerialDateToDate(dateStr, timezone);
    if (date) {
      const withTime = applyTimeParts(date, timeStr, timezone);
      return !withTime || isNaN(withTime.getTime()) ? null : withTime;
    }
  }
  return parseDateString(dateStr, timeStr, timezone);
};

const transactionDateError = (date, timezone) => {
  const limits = parserLimits();
  const earliest = zonedDayStart(`${limits.minYear}-01-01`, timezone);
  const latest = addZonedDays(new Date(), limits.maxFutureDays, timezone);
  if (!date || Number.isNaN(date.getTime())) return 'Could not parse date or time';
  if (date < earliest) return `Transaction date is before ${limits.minYear}`;
  if (date > latest) return `Transaction date is more than ${limits.maxFutureDays} days in the future`;
  return null;
};

const temporalFields = (date, timezone) => {
  const parts = getZonedDateParts(date, timezone);
  return {
    hour: parts.hour,
    dayOfWeek: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    // The cafe-local trading day. Receipt numbers are only unique within a day
    // on tills that restart their numbering, so identity has to be scoped by it.
    dateKey: zonedDateKey(date, timezone),
  };
};

module.exports = {
  parseDate, transactionDateError, temporalFields,
};
