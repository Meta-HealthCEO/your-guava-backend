jest.mock('../../src/models/Cafe.model', () => ({ findById: jest.fn() }));

const Cafe = require('../../src/models/Cafe.model');
const {
  DATE_ONLY_RE, TIME_OF_DAY_RE, safeTimezone, zonedDayStart, zonedDateKey, getCafeTimezone,
  parseDateOnly, formatDateOnly, inclusiveDateOnlyDays, cafeLocalToday,
} = require('../../src/utils/timezone');

const cafeWith = (value) => ({ select: () => ({ lean: async () => value }) });

describe('utils/timezone, the one home of cafe-local dates (BE-11-T05)', () => {
  it('falls back to the cafe default for a missing or unknown zone, never the process zone', () => {
    expect(safeTimezone(undefined)).toBe('Africa/Johannesburg');
    expect(safeTimezone('Not/AZone')).toBe('Africa/Johannesburg');
    expect(safeTimezone('America/New_York')).toBe('America/New_York');
  });

  it('reads a cafe timezone and falls back when the cafe or its field is missing', async () => {
    Cafe.findById.mockReturnValueOnce(cafeWith({ timezone: 'America/New_York' }));
    await expect(getCafeTimezone('cafe-1')).resolves.toBe('America/New_York');
    Cafe.findById.mockReturnValueOnce(cafeWith(null));
    await expect(getCafeTimezone('cafe-2')).resolves.toBe('Africa/Johannesburg');
  });

  it('parses a strict YYYY-MM-DD to UTC midnight and refuses everything else', () => {
    expect(parseDateOnly('2026-09-27').toISOString()).toBe('2026-09-27T00:00:00.000Z');
    expect(parseDateOnly('2026-02-30')).toBeNull();
    expect(parseDateOnly('27/09/2026')).toBeNull();
    expect(parseDateOnly(' 2026-09-27')).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
  });

  it('formats a date-only value and counts the days between two, inclusive', () => {
    expect(formatDateOnly(new Date('2026-09-27T00:00:00Z'))).toBe('2026-09-27');
    expect(inclusiveDateOnlyDays(parseDateOnly('2026-09-21'), parseDateOnly('2026-09-27'))).toBe(7);
  });

  it('gives the cafe-local calendar day, not the UTC one', () => {
    // 00:30 on Monday 21 September in Johannesburg is still Sunday 20 September in UTC and in New York.
    const now = new Date('2026-09-20T22:30:00Z');
    expect(formatDateOnly(cafeLocalToday('Africa/Johannesburg', now))).toBe('2026-09-21');
    expect(formatDateOnly(cafeLocalToday('America/New_York', now))).toBe('2026-09-20');
  });

  it('has one pattern for a date-only string and one for a time of day', () => {
    expect(DATE_ONLY_RE.test('2026-09-27')).toBe(true);
    expect(TIME_OF_DAY_RE.test('23:59')).toBe(true);
    expect(TIME_OF_DAY_RE.test('24:00')).toBe(false);
  });

  it('computes Johannesburg day boundaries the same way whatever zone the process runs in', () => {
    expect(zonedDayStart('2026-09-27', 'Africa/Johannesburg').toISOString()).toBe('2026-09-26T22:00:00.000Z');
    expect(zonedDateKey(new Date('2026-09-26T22:30:00Z'), 'Africa/Johannesburg')).toBe('2026-09-27');
  });
});
