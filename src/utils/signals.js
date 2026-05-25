const axios = require('axios');

// Simple in-memory cache for load shedding stage
let loadSheddingCache = { stage: 0, fetchedAt: null };
const LOAD_SHEDDING_CACHE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Returns true if the given date is a payday:
 * - 25th of the month
 * - 1st of the month
 * - Last business day of the month
 */
const isPayday = (date) => {
  const d = new Date(date);
  const day = d.getDate();
  const month = d.getMonth();
  const year = d.getFullYear();

  if (day === 25 || day === 1) return true;

  // Check if it is the last business day of the month
  const lastDay = new Date(year, month + 1, 0); // last day of month
  let lastBizDay = new Date(lastDay);
  // Walk back to the nearest Mon-Fri
  while (lastBizDay.getDay() === 0 || lastBizDay.getDay() === 6) {
    lastBizDay.setDate(lastBizDay.getDate() - 1);
  }

  return (
    d.getFullYear() === lastBizDay.getFullYear() &&
    d.getMonth() === lastBizDay.getMonth() &&
    d.getDate() === lastBizDay.getDate()
  );
};

const toDateKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const addDays = (date, days) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const isSameLocalDate = (a, b = new Date()) => {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
};

const addHoliday = (holidays, date, name, observedOf) => {
  holidays.set(toDateKey(date), { date: toDateKey(date), name, observedOf });
};

const calculateEasterSunday = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
};

const SPECIAL_PUBLIC_HOLIDAYS = {
  // National election days and formally declared one-off public holidays.
  '2019-05-08': 'National and Provincial Elections',
  '2021-11-01': 'Local Government Elections',
  '2022-12-27': 'Special Public Holiday',
  '2024-05-29': 'National and Provincial Elections',
};

const publicHolidayOverrides = () => {
  const raw = process.env.PUBLIC_HOLIDAY_OVERRIDES || process.env.SA_PUBLIC_HOLIDAY_OVERRIDES || '';
  if (!raw.trim()) return {};

  return raw.split(',').reduce((overrides, item) => {
    const [date, ...nameParts] = item.trim().split(':');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      overrides[date] = nameParts.join(':').trim() || 'Special Public Holiday';
    }
    return overrides;
  }, {});
};

const getPublicHolidaysForYear = (year) => {
  const holidays = new Map();
  const fixedHolidays = [
    [1, 1, "New Year's Day"],
    [3, 21, 'Human Rights Day'],
    [4, 27, 'Freedom Day'],
    [5, 1, 'Workers Day'],
    [6, 16, 'Youth Day'],
    [8, 9, "National Women's Day"],
    [9, 24, 'Heritage Day'],
    [12, 16, 'Day of Reconciliation'],
    [12, 25, 'Christmas Day'],
    [12, 26, 'Day of Goodwill'],
  ];

  for (const [month, day, name] of fixedHolidays) {
    addHoliday(holidays, new Date(year, month - 1, day), name);
  }

  const easterSunday = calculateEasterSunday(year);
  addHoliday(holidays, addDays(easterSunday, -2), 'Good Friday');
  addHoliday(holidays, addDays(easterSunday, 1), 'Family Day');

  const baseHolidays = [...holidays.values()];
  for (const holiday of baseHolidays) {
    const holidayDate = new Date(holiday.date);
    if (holidayDate.getDay() === 0) {
      addHoliday(holidays, addDays(holidayDate, 1), `${holiday.name} observed`, holiday.name);
    }
  }

  const allSpecialHolidays = { ...SPECIAL_PUBLIC_HOLIDAYS, ...publicHolidayOverrides() };
  for (const [date, name] of Object.entries(allSpecialHolidays)) {
    if (date.startsWith(`${year}-`)) {
      addHoliday(holidays, new Date(date), name);
    }
  }

  return [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date));
};

const getPublicHolidayInfo = (date) => {
  const d = new Date(date);
  const dateKey = toDateKey(d);
  return getPublicHolidaysForYear(d.getFullYear()).find((holiday) => holiday.date === dateKey) || null;
};

/**
 * Returns true if the given date is a South African public holiday.
 */
const isPublicHoliday = (date) => {
  return Boolean(getPublicHolidayInfo(date));
};

/**
 * Returns true if the given date falls outside Western Cape school terms (2025-2026).
 * Non-term days are considered school holidays.
 */
const isSchoolHoliday = (date) => {
  const d = new Date(date);
  // Strip time for date-only comparison
  const check = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const terms = [
    // 2025 terms (approximate WC dates)
    { start: new Date(2025, 0, 15), end: new Date(2025, 2, 28) },  // Term 1
    { start: new Date(2025, 3, 22), end: new Date(2025, 5, 27) },  // Term 2
    { start: new Date(2025, 6, 22), end: new Date(2025, 8, 26) },  // Term 3
    { start: new Date(2025, 9, 7),  end: new Date(2025, 11, 12) }, // Term 4
    // 2026 terms
    { start: new Date(2026, 0, 14), end: new Date(2026, 2, 27) },  // Term 1
    { start: new Date(2026, 3, 14), end: new Date(2026, 5, 26) },  // Term 2
    { start: new Date(2026, 6, 21), end: new Date(2026, 8, 25) },  // Term 3
    { start: new Date(2026, 9, 6),  end: new Date(2026, 11, 11) }, // Term 4
  ];

  for (const term of terms) {
    if (check >= term.start && check <= term.end) {
      return false; // In a school term — not a school holiday
    }
  }

  return true; // Outside all terms — school holiday
};

/**
 * Fetches the current EskomSePush load shedding stage.
 * Returns 0 if unavailable or no load shedding.
 * Caches for 30 minutes.
 */
const getLoadSheddingStage = async () => {
  if (process.env.NODE_ENV === 'test') return 0;

  const now = Date.now();
  if (
    loadSheddingCache.fetchedAt &&
    now - loadSheddingCache.fetchedAt < LOAD_SHEDDING_CACHE_MS
  ) {
    return loadSheddingCache.stage;
  }

  try {
    const apiKey = process.env.ESKOMSEPUSH_API_KEY;
    if (!apiKey) return 0;

    const response = await axios.get(
      'https://developer.sepush.co.za/business/2.0/status',
      {
        headers: { Token: apiKey },
        timeout: 5000,
      }
    );

    const stage = response.data?.status?.capetown?.stage || 0;
    loadSheddingCache = { stage: Number(stage), fetchedAt: now };
    return loadSheddingCache.stage;
  } catch (error) {
    console.error('[signals] Load shedding API error:', error.message);
    return loadSheddingCache.stage || 0;
  }
};

/**
 * Aggregates all signals for a given date and location.
 */
const getSignalsForDate = async (date, location = {}) => {
  const d = new Date(date);
  const dayOfWeek = d.getDay();

  const loadSheddingStage = isSameLocalDate(d) ? await getLoadSheddingStage() : 0;

  return {
    isPayday: isPayday(d),
    isPublicHoliday: isPublicHoliday(d),
    isSchoolHoliday: isSchoolHoliday(d),
    loadSheddingStage,
    dayOfWeek,
  };
};

module.exports = {
  isPayday,
  isPublicHoliday,
  getPublicHolidayInfo,
  getPublicHolidaysForYear,
  isSchoolHoliday,
  getLoadSheddingStage,
  getSignalsForDate,
};
