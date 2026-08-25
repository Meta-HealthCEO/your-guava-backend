const { normalizePaymentReference } = require('../../src/services/billingPayments.service');

/**
 * A payment reference arrives on unauthenticated webhook routes, so it is
 * attacker-controlled. It is used to build a Mongoose filter, and Mongoose
 * treats an object containing $ operators as query syntax rather than a value
 * to cast. Passing {"$ne": null} therefore selected an arbitrary PaymentSession
 * belonging to any tenant, and the handler went on to act on it.
 */
describe('normalizePaymentReference', () => {
  it('accepts an ordinary reference', () => {
    expect(normalizePaymentReference('GGCMPKI1PUPB744A1')).toBe('GGCMPKI1PUPB744A1');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePaymentReference('  GGC1  ')).toBe('GGC1');
  });

  it('refuses a query operator object', () => {
    expect(normalizePaymentReference({ $ne: null })).toBeNull();
    expect(normalizePaymentReference({ $gt: '' })).toBeNull();
    expect(normalizePaymentReference({ $regex: '.*' })).toBeNull();
  });

  it('refuses arrays, which Mongoose would read as an $in-style match', () => {
    expect(normalizePaymentReference(['GGC1', 'GGC2'])).toBeNull();
  });

  it('refuses empty and non-string primitives', () => {
    expect(normalizePaymentReference('')).toBeNull();
    expect(normalizePaymentReference('   ')).toBeNull();
    expect(normalizePaymentReference(null)).toBeNull();
    expect(normalizePaymentReference(undefined)).toBeNull();
    expect(normalizePaymentReference(12345)).toBeNull();
    expect(normalizePaymentReference(true)).toBeNull();
  });

  it('refuses an over-long value rather than querying on it', () => {
    expect(normalizePaymentReference('G'.repeat(300))).toBeNull();
  });
});
