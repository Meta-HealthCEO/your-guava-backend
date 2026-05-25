const HOURS_TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DEFAULT_WEEKDAY = { isOpen: true, openTime: '07:00', closeTime: '17:00' };
const DEFAULT_SATURDAY = { isOpen: true, openTime: '08:00', closeTime: '15:00' };
const DEFAULT_SUNDAY = { isOpen: false, openTime: '08:00', closeTime: '14:00' };

const defaultTradingHours = () => Array.from({ length: 7 }, (_, dayOfWeek) => {
  const template = dayOfWeek === 0
    ? DEFAULT_SUNDAY
    : dayOfWeek === 6
      ? DEFAULT_SATURDAY
      : DEFAULT_WEEKDAY;
  return { dayOfWeek, ...template };
});

const parseTime = (value) => {
  if (typeof value !== 'string') return null;
  const match = HOURS_TIME_RE.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
};

const normalizeTradingHours = (input) => {
  if (!Array.isArray(input)) return defaultTradingHours();

  const byDay = new Map();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const dayOfWeek = Number(entry.dayOfWeek);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) continue;

    const isOpen = entry.isOpen !== false;
    const openTime = parseTime(entry.openTime) != null ? entry.openTime : '07:00';
    const closeTime = parseTime(entry.closeTime) != null ? entry.closeTime : '17:00';

    if (isOpen && parseTime(closeTime) <= parseTime(openTime)) {
      const error = new Error(`closeTime must be after openTime for day ${dayOfWeek}`);
      error.statusCode = 400;
      throw error;
    }

    byDay.set(dayOfWeek, { dayOfWeek, isOpen, openTime, closeTime });
  }

  return defaultTradingHours().map((fallback) => byDay.get(fallback.dayOfWeek) || fallback);
};

const getCafeTradingHours = (cafe) => {
  if (cafe && Array.isArray(cafe.tradingHours) && cafe.tradingHours.length === 7) {
    return cafe.tradingHours;
  }
  return defaultTradingHours();
};

const findClosureEvent = (events) => {
  if (!Array.isArray(events)) return null;
  return events.find((event) => event && event.type === 'closure') || null;
};

const findPartialClosure = (events) => {
  if (!Array.isArray(events)) return null;
  return events.find((event) => event && event.type === 'partial_closure' && event.closureWindow) || null;
};

const getOpenWindowForDate = (date, cafe, eventsForDate = []) => {
  const dayOfWeek = date instanceof Date ? date.getDay() : new Date(date).getDay();
  const schedule = getCafeTradingHours(cafe).find((row) => row.dayOfWeek === dayOfWeek);

  if (!schedule || !schedule.isOpen) {
    return { isOpen: false, openMinutes: null, closeMinutes: null };
  }

  if (findClosureEvent(eventsForDate)) {
    return { isOpen: false, openMinutes: null, closeMinutes: null };
  }

  let openMinutes = parseTime(schedule.openTime);
  let closeMinutes = parseTime(schedule.closeTime);

  const partial = findPartialClosure(eventsForDate);
  if (partial && partial.closureWindow) {
    const closureStart = parseTime(partial.closureWindow.startTime);
    const closureEnd = parseTime(partial.closureWindow.endTime);
    if (closureStart != null && closureEnd != null && closureEnd > closureStart) {
      // Trim trading window to the largest contiguous piece outside the closure.
      const morningSpan = closureStart - openMinutes;
      const eveningSpan = closeMinutes - closureEnd;
      if (morningSpan <= 0 && eveningSpan <= 0) {
        return { isOpen: false, openMinutes: null, closeMinutes: null };
      }
      if (eveningSpan > morningSpan) {
        openMinutes = closureEnd;
      } else {
        closeMinutes = closureStart;
      }
    }
  }

  if (closeMinutes <= openMinutes) {
    return { isOpen: false, openMinutes: null, closeMinutes: null };
  }

  return { isOpen: true, openMinutes, closeMinutes };
};

const isHourOpen = (hour, openWindow) => {
  if (!openWindow || !openWindow.isOpen) return false;
  const hourStart = hour * 60;
  const hourEnd = hourStart + 60;
  return hourEnd > openWindow.openMinutes && hourStart < openWindow.closeMinutes;
};

const isWeekdayHourOpen = (dayOfWeek, hour, cafe) => {
  const schedule = getCafeTradingHours(cafe).find((row) => row.dayOfWeek === dayOfWeek);
  if (!schedule || !schedule.isOpen) return false;
  const openMinutes = parseTime(schedule.openTime);
  const closeMinutes = parseTime(schedule.closeTime);
  if (openMinutes == null || closeMinutes == null || closeMinutes <= openMinutes) return false;
  return isHourOpen(hour, { isOpen: true, openMinutes, closeMinutes });
};

module.exports = {
  defaultTradingHours,
  normalizeTradingHours,
  getCafeTradingHours,
  getOpenWindowForDate,
  isHourOpen,
  isWeekdayHourOpen,
  parseTime,
};
