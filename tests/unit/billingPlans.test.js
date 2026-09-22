const {
  addBillingCycle,
  addUtcMonthsClamped,
  nextMonthlyAnniversary,
  startOfNextUtcMonth,
} = require('../../src/services/billingPlans.service');

describe('billing plan date arithmetic', () => {
  it('moves a month-end instant to the first day of the next UTC month', () => {
    expect(startOfNextUtcMonth(new Date('2026-01-31T23:59:59.000Z')).toISOString())
      .toBe('2026-02-01T00:00:00.000Z');
  });

  it('clamps monthly billing cycles to the final valid day', () => {
    expect(addUtcMonthsClamped(new Date('2026-01-31T08:15:00.000Z'), 1).toISOString())
      .toBe('2026-02-28T08:15:00.000Z');
    expect(addBillingCycle(new Date('2024-01-31T08:15:00.000Z'), 'monthly').toISOString())
      .toBe('2024-02-29T08:15:00.000Z');
  });

  it('preserves the instant fields when adding an annual billing cycle', () => {
    expect(addBillingCycle(new Date('2024-02-29T12:34:56.789Z'), 'annual').toISOString())
      .toBe('2025-02-28T12:34:56.789Z');
  });
});

describe('nextMonthlyAnniversary', () => {
  const anniversary = (anchor, from) =>
    nextMonthlyAnniversary(new Date(anchor), new Date(from)).toISOString();

  it('returns the next anniversary strictly after the reference instant', () => {
    expect(anniversary('2026-01-20T10:00:00.000Z', '2026-01-20T09:59:59.000Z'))
      .toBe('2026-01-20T10:00:00.000Z');
    expect(anniversary('2026-01-20T10:00:00.000Z', '2026-01-20T10:00:00.000Z'))
      .toBe('2026-02-20T10:00:00.000Z');
    expect(anniversary('2026-01-20T10:00:00.000Z', '2026-02-01T00:00:00.000Z'))
      .toBe('2026-02-20T10:00:00.000Z');
  });

  it('skips whole months when the anchor is far in the past', () => {
    expect(anniversary('2024-03-05T08:00:00.000Z', '2026-07-04T23:59:59.000Z'))
      .toBe('2026-07-05T08:00:00.000Z');
    expect(anniversary('2024-03-05T08:00:00.000Z', '2026-07-05T08:00:00.000Z'))
      .toBe('2026-08-05T08:00:00.000Z');
  });

  it('clamps a month-end anchor without letting the anniversary drift earlier', () => {
    expect(anniversary('2026-01-31T06:00:00.000Z', '2026-01-31T06:00:01.000Z'))
      .toBe('2026-02-28T06:00:00.000Z');
    expect(anniversary('2026-01-31T06:00:00.000Z', '2026-02-28T06:00:01.000Z'))
      .toBe('2026-03-31T06:00:00.000Z');
  });

  it('returns an anchor that has not happened yet unchanged', () => {
    expect(anniversary('2026-05-10T00:00:00.000Z', '2026-01-01T00:00:00.000Z'))
      .toBe('2026-05-10T00:00:00.000Z');
  });
});
