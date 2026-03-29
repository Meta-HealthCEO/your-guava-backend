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

/**
 * Returns true if the given date is a South African public holiday (2025-2026).
 */
const isPublicHoliday = (date) => {
  const d = new Date(date);
  const month = d.getMonth() + 1; // 1-indexed
  const day = d.getDate();
  const year = d.getFullYear();

  const holidays = [
    // Fixed holidays (month, day)
    [1, 1],   // New Year's Day
    [3, 21],  // Human Rights Day
    [4, 27],  // Freedom Day
    [5, 1],   // Workers Day
    [6, 16],  // Youth Day
    [8, 9],   // National Women's Day
    [9, 24],  // Heritage Day
    [12, 16], // Day of Reconciliation
    [12, 25], // Christmas Day
    [12, 26], // Day of Goodwill
  ];

  for (const [hMonth, hDay] of holidays) {
    if (month === hMonth && day === hDay) return true;
  }

  // Variable holidays (Easter-based) - hardcoded for 2025 and 2026
  const variableHolidays = [
    // 2025
    '2025-04-18', // Good Friday
    '2025-04-21', // Family Day (Easter Monday)
    // 2026
    '2026-04-03', // Good Friday
    '2026-04-06', // Family Day (Easter Monday)
  ];

  const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return variableHolidays.includes(dateStr);
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

  const [loadSheddingStage] = await Promise.all([getLoadSheddingStage()]);

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
  isSchoolHoliday,
  getLoadSheddingStage,
  getSignalsForDate,
};
