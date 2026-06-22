const axios = require('axios');

// Simple in-memory cache for load shedding status (both reported areas)
let loadSheddingCache = { stages: null, fetchedAt: null };
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

const parseLocalDateKey = (dateKey) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || '').trim());
  if (!match) return null;

  const [, yearValue, monthValue, dayValue] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  const parsed = new Date(year, month - 1, day);

  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }

  return parsed;
};

const normalizeSchoolTerm = (term) => {
  const startValue = Array.isArray(term) ? term[0] : term?.start;
  const endValue = Array.isArray(term) ? term[1] : term?.end;
  const start = parseLocalDateKey(startValue);
  const end = parseLocalDateKey(endValue);

  if (!start || !end || end < start) return null;
  return { start, end };
};

const normalizeSchoolCalendar = (year, calendar) => {
  const yearNumber = Number(year);
  const termsInput = Array.isArray(calendar) ? calendar : calendar?.terms;
  if (!Number.isInteger(yearNumber) || !Array.isArray(termsInput) || termsInput.length !== 4) {
    return null;
  }

  const terms = termsInput.map(normalizeSchoolTerm);
  if (
    terms.some((term) => !term) ||
    terms.some((term) => term.start.getFullYear() !== yearNumber || term.end.getFullYear() !== yearNumber)
  ) {
    return null;
  }
  terms.sort((a, b) => a.start - b.start);
  if (terms.some((term, index) => index > 0 && term.start <= terms[index - 1].end)) {
    return null;
  }

  const specialSchoolHolidaysInput = Array.isArray(calendar?.specialSchoolHolidays)
    ? calendar.specialSchoolHolidays
    : [];
  const specialSchoolHolidays = [...new Set(
    specialSchoolHolidaysInput
      .map((dateKey) => parseLocalDateKey(dateKey))
      .filter((date) => date && date.getFullYear() === yearNumber)
      .map(toDateKey)
  )].sort();

  return { terms, specialSchoolHolidays };
};

const buildSchoolCalendarMap = (calendars) => {
  return Object.entries(calendars).reduce((built, [year, calendar]) => {
    const normalized = normalizeSchoolCalendar(year, calendar);
    if (normalized) built[year] = normalized;
    return built;
  }, {});
};

// Source-backed South African public school calendars. Learner dates are used
// for demand signals; educator-only admin days are treated as school holidays.
const DEFAULT_SCHOOL_CALENDARS_BY_YEAR = buildSchoolCalendarMap({
  2025: {
    terms: [
      ['2025-01-15', '2025-03-28'],
      ['2025-04-08', '2025-06-27'],
      ['2025-07-22', '2025-10-03'],
      ['2025-10-13', '2025-12-10'],
    ],
    specialSchoolHolidays: ['2025-04-29', '2025-04-30', '2025-05-02'],
  },
  2026: {
    terms: [
      ['2026-01-14', '2026-03-27'],
      ['2026-04-08', '2026-06-26'],
      ['2026-07-21', '2026-09-23'],
      ['2026-10-06', '2026-12-09'],
    ],
    specialSchoolHolidays: ['2026-06-15'],
  },
  2027: {
    terms: [
      ['2027-01-13', '2027-03-19'],
      ['2027-04-06', '2027-06-25'],
      ['2027-07-20', '2027-09-22'],
      ['2027-10-05', '2027-12-08'],
    ],
    specialSchoolHolidays: ['2027-04-26'],
  },
});

let schoolCalendarOverrideCache = { raw: null, value: {} };

const parseSchoolCalendarOverrides = () => {
  const raw = (
    process.env.SCHOOL_CALENDAR_OVERRIDES ||
    process.env.SCHOOL_TERM_OVERRIDES ||
    process.env.SA_SCHOOL_TERM_OVERRIDES ||
    ''
  ).trim();

  if (schoolCalendarOverrideCache.raw === raw) {
    return schoolCalendarOverrideCache.value;
  }

  if (!raw) {
    schoolCalendarOverrideCache = { raw, value: {} };
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    const value = buildSchoolCalendarMap(parsed && typeof parsed === 'object' ? parsed : {});
    schoolCalendarOverrideCache = { raw, value };
    return value;
  } catch (error) {
    schoolCalendarOverrideCache = { raw, value: {} };
    return {};
  }
};

const getSchoolCalendarDatesForYear = (year) => {
  const yearNumber = Number(year);
  if (!Number.isInteger(yearNumber)) return null;

  const overrides = parseSchoolCalendarOverrides();
  return overrides[yearNumber] || DEFAULT_SCHOOL_CALENDARS_BY_YEAR[yearNumber] || null;
};

const getSchoolCalendarForYear = (year) => {
  const calendar = getSchoolCalendarDatesForYear(year);
  if (!calendar) return null;

  return {
    terms: calendar.terms.map((term) => ({
      start: toDateKey(term.start),
      end: toDateKey(term.end),
    })),
    specialSchoolHolidays: [...calendar.specialSchoolHolidays],
  };
};

/**
 * Returns true if the given date falls outside learner school terms or is a
 * gazetted special school holiday.
 * Fails safe: when term dates for the date's year are unknown, returns false
 * (no signal) instead of treating every day as a school holiday.
 */
const isSchoolHoliday = (date) => {
  const d = new Date(date);
  // Strip time for date-only comparison
  const check = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  const dateKey = toDateKey(check);
  const calendar = getSchoolCalendarDatesForYear(check.getFullYear());
  if (!calendar) {
    return false; // Unknown year: no school-holiday signal rather than a permanent one.
  }

  if (calendar.specialSchoolHolidays.includes(dateKey)) {
    return true;
  }

  for (const term of calendar.terms) {
    if (check >= term.start && check <= term.end) {
      return false; // In a learner school term.
    }
  }

  return true; // Outside all learner terms.
};

// Cape Town runs its own load shedding schedule; everywhere else follows Eskom national.
const loadSheddingAreaForCity = (city = '') =>
  /cape\s*town/i.test(String(city)) ? 'capetown' : 'eskom';

/**
 * Fetches the current EskomSePush load shedding stage for the cafe's area.
 * Cape Town cafes use the City of Cape Town stage; all other locations use
 * the Eskom national stage. Returns 0 if unavailable. Caches for 30 minutes.
 */
const getLoadSheddingStage = async (city) => {
  if (process.env.NODE_ENV === 'test') return 0;

  const area = loadSheddingAreaForCity(city);
  const now = Date.now();
  if (
    loadSheddingCache.fetchedAt &&
    now - loadSheddingCache.fetchedAt < LOAD_SHEDDING_CACHE_MS &&
    loadSheddingCache.stages
  ) {
    return loadSheddingCache.stages[area] || 0;
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

    const stages = {
      capetown: Number(response.data?.status?.capetown?.stage || 0),
      eskom: Number(response.data?.status?.eskom?.stage || 0),
    };
    loadSheddingCache = { stages, fetchedAt: now };
    return stages[area] || 0;
  } catch (error) {
    console.error('[signals] Load shedding API error:', error.message);
    return loadSheddingCache.stages?.[area] || 0;
  }
};

/**
 * Aggregates all signals for a given date and location.
 */
const getSignalsForDate = async (date, location = {}) => {
  const d = new Date(date);
  const dayOfWeek = d.getDay();

  const loadSheddingStage = isSameLocalDate(d) ? await getLoadSheddingStage(location.city) : 0;

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
  getSchoolCalendarForYear,
  isSchoolHoliday,
  getLoadSheddingStage,
  getSignalsForDate,
};
