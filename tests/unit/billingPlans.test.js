const {
  addBillingCycle,
  addUtcMonthsClamped,
  nextCreditResetDate,
} = require('../../src/services/billingPlans.service');

describe('billing plan date arithmetic', () => {
  it('moves a month-end reset to the first day of the next UTC month', () => {
    expect(nextCreditResetDate(new Date('2026-01-31T23:59:59.000Z')).toISOString())
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
