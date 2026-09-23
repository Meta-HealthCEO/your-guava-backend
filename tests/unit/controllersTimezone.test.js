const { buildDateMatch, inclusiveLocalDayCount } = require('../../src/controllers/analytics/range');

describe('analytics windows follow the cafe zone, not the process zone (BE-11-T05, WS-08-T01)', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-22T09:00:00.000Z')));
  afterEach(() => jest.useRealTimers());

  it('starts the default 30-day window at Johannesburg midnight 29 days back', () => {
    // 22 Sep 11:00 SAST: the window is 24 Aug 00:00 SAST (23 Aug 22:00 UTC) to now.
    const match = buildDateMatch({}, 'Africa/Johannesburg');
    expect(match.$gte.toISOString()).toBe('2026-08-23T22:00:00.000Z');
    expect(match.$lte.toISOString()).toBe('2026-09-22T09:00:00.000Z');
  });

  it('closes an explicit endDate at 23:59:59.999 cafe time', () => {
    const match = buildDateMatch({ startDate: '2026-09-01', endDate: '2026-09-07' }, 'Africa/Johannesburg');
    expect(match.$gte.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(match.$lte.toISOString()).toBe('2026-09-07T21:59:59.999Z');
    expect(inclusiveLocalDayCount(match.$gte, match.$lte, 'Africa/Johannesburg')).toBe(7);
  });

  it('refuses an impossible calendar date with a 400', () => {
    expect(() => buildDateMatch({ startDate: '2026-02-30' }, 'Africa/Johannesburg')).toThrow(expect.objectContaining({ statusCode: 400 }));
  });
});
