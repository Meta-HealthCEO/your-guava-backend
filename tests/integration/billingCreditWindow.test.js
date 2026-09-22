const {
  setup,
  teardown,
  clearDB,
  createTestUser,
} = require('../setup');
const Organization = require('../../src/models/Organization.model');
const PaymentSession = require('../../src/models/PaymentSession.model');
const oneGate = require('../../src/services/onegate.service');
const { reconcileOneGatePayment } = require('../../src/services/billingPayments.service');
const { refreshCreditWindow } = require('../../src/services/usage.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const setOrganization = (orgId, fields) =>
  Organization.updateOne({ _id: orgId }, { $set: fields });

/**
 * A Guava Credit allowance belongs to a billing period, and the period is
 * defined by the subscription rather than the calendar. Anchoring the window on
 * the calendar rollover handed every organisation whose renewal day is not the
 * 1st two full allowances a month -- one at the rollover and one at its own
 * renewal -- which the business pays for in Anthropic and weather spend.
 */
describe('included Guava Credit window', () => {
  it('grants one included allowance per billing month when the renewal day is not the 1st', async () => {
    const owner = await createTestUser();
    await setOrganization(owner.user.orgId, {
      plan: 'growth',
      billingStatus: 'active',
      billingCycle: 'monthly',
      subscriptionStartedAt: new Date('2025-12-20T10:00:00.000Z'),
      currentPeriodStart: new Date('2026-01-20T10:00:00.000Z'),
      currentPeriodEnd: new Date('2026-02-20T10:00:00.000Z'),
      'aiCredits.included': 1800,
      'aiCredits.bonus': 0,
      'aiCredits.bonusUsed': 0,
      'aiCredits.used': 900,
      'aiCredits.resetAt': new Date('2026-01-20T10:00:00.000Z'),
    });

    const refilled = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-01-20T10:00:01.000Z')
    );
    expect(refilled.aiCredits.used).toBe(0);
    expect(refilled.aiCredits.resetAt.toISOString()).toBe('2026-02-20T10:00:00.000Z');

    await setOrganization(owner.user.orgId, { 'aiCredits.used': 900 });
    const atCalendarRollover = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-02-01T00:00:01.000Z')
    );
    expect(atCalendarRollover.aiCredits.used).toBe(900);
    expect(atCalendarRollover.aiCredits.resetAt.toISOString()).toBe('2026-02-20T10:00:00.000Z');
  });

  it('never grants a second allowance when refreshes race across the window boundary', async () => {
    const owner = await createTestUser();
    await setOrganization(owner.user.orgId, {
      plan: 'growth',
      billingStatus: 'active',
      billingCycle: 'monthly',
      subscriptionStartedAt: new Date('2025-12-20T10:00:00.000Z'),
      currentPeriodStart: new Date('2026-01-20T10:00:00.000Z'),
      currentPeriodEnd: new Date('2026-03-20T10:00:00.000Z'),
      'aiCredits.included': 1800,
      'aiCredits.bonus': 0,
      'aiCredits.bonusUsed': 0,
      'aiCredits.used': 900,
      'aiCredits.resetAt': new Date('2026-01-20T10:00:00.000Z'),
    });

    const boundary = new Date('2026-01-20T10:00:01.000Z');
    await Promise.all(
      Array.from({ length: 4 }, () => refreshCreditWindow(owner.user.orgId, boundary))
    );
    const opened = await Organization.findById(owner.user.orgId).lean();
    expect(opened.aiCredits.used).toBe(0);
    expect(opened.aiCredits.resetAt.toISOString()).toBe('2026-02-20T10:00:00.000Z');

    // Spend inside the fresh window, then race refreshes at the calendar
    // rollover: none of them may top the balance back up.
    await setOrganization(owner.user.orgId, { 'aiCredits.used': 900 });
    const rollover = new Date('2026-02-01T00:00:01.000Z');
    await Promise.all(
      Array.from({ length: 4 }, () => refreshCreditWindow(owner.user.orgId, rollover))
    );
    const held = await Organization.findById(owner.user.orgId).lean();
    expect(held.aiCredits.used).toBe(900);
    expect(held.aiCredits.resetAt.toISOString()).toBe('2026-02-20T10:00:00.000Z');
  });

  it('keeps refreshing an annual subscription monthly on its own anniversary', async () => {
    const owner = await createTestUser();
    await setOrganization(owner.user.orgId, {
      plan: 'growth',
      billingStatus: 'active',
      billingCycle: 'annual',
      subscriptionStartedAt: new Date('2026-01-20T10:00:00.000Z'),
      currentPeriodStart: new Date('2026-01-20T10:00:00.000Z'),
      currentPeriodEnd: new Date('2027-01-20T10:00:00.000Z'),
      'aiCredits.included': 1800,
      'aiCredits.bonus': 0,
      'aiCredits.bonusUsed': 0,
      'aiCredits.used': 1200,
      'aiCredits.resetAt': new Date('2026-02-20T10:00:00.000Z'),
    });

    const refilled = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-02-20T10:00:01.000Z')
    );
    expect(refilled.aiCredits.used).toBe(0);
    expect(refilled.aiCredits.resetAt.toISOString()).toBe('2026-03-20T10:00:00.000Z');
  });

  it('still refreshes a legacy annual organisation monthly when no period start was stored', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      {
        $set: {
          plan: 'growth',
          billingStatus: 'active',
          billingCycle: 'annual',
          currentPeriodEnd: new Date('2027-01-20T10:00:00.000Z'),
          'aiCredits.included': 1800,
          'aiCredits.bonus': 0,
          'aiCredits.bonusUsed': 0,
          'aiCredits.used': 1200,
          'aiCredits.resetAt': new Date('2026-03-20T10:00:00.000Z'),
        },
        $unset: { currentPeriodStart: 1, subscriptionStartedAt: 1 },
      }
    );

    const refilled = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-03-20T10:00:01.000Z')
    );
    expect(refilled.aiCredits.used).toBe(0);
    expect(refilled.aiCredits.resetAt.toISOString()).toBe('2026-04-20T10:00:00.000Z');
  });

  it('clamps a month-end anniversary to a short month and then returns to the anchor day', async () => {
    const owner = await createTestUser();
    await setOrganization(owner.user.orgId, {
      plan: 'starter',
      billingStatus: 'active',
      billingCycle: 'monthly',
      subscriptionStartedAt: new Date('2026-01-31T06:00:00.000Z'),
      currentPeriodStart: new Date('2026-01-31T06:00:00.000Z'),
      currentPeriodEnd: new Date('2026-02-28T06:00:00.000Z'),
      'aiCredits.included': 400,
      'aiCredits.bonus': 0,
      'aiCredits.bonusUsed': 0,
      'aiCredits.used': 100,
      'aiCredits.resetAt': new Date('2026-01-31T06:00:00.000Z'),
    });

    const shortMonth = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-01-31T06:00:01.000Z')
    );
    expect(shortMonth.aiCredits.resetAt.toISOString()).toBe('2026-02-28T06:00:00.000Z');

    // The customer renews, so the paid period runs to the 31st again. The next
    // window must come off the subscription anchor, not off the clamped 28th.
    await setOrganization(owner.user.orgId, {
      currentPeriodEnd: new Date('2026-03-31T06:00:00.000Z'),
      'aiCredits.used': 100,
    });
    const backToAnchorDay = await refreshCreditWindow(
      owner.user.orgId,
      new Date('2026-02-28T06:00:01.000Z')
    );
    expect(backToAnchorDay.aiCredits.used).toBe(0);
    expect(backToAnchorDay.aiCredits.resetAt.toISOString()).toBe('2026-03-31T06:00:00.000Z');
  });

  it('anchors the first paid window on the subscription, not on the calendar rollover', async () => {
    const owner = await createTestUser();
    const session = await PaymentSession.create({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      provider: 'onegate',
      kind: 'plan',
      reference: 'trial-conversion-plan-payment',
      amount: 899,
      currency: 'ZAR',
      plan: 'growth',
      billingCycle: 'monthly',
    });
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 'trial-conversion-provider-payment',
      successful: 1,
      status: 'complete',
      amount: '899.00',
      currency: 'ZAR',
      merchant_reference: session.reference,
    });

    await reconcileOneGatePayment(session.reference);

    const org = await Organization.findById(owner.user.orgId).lean();
    // A monthly period is exactly one credit window, so the first refill is due
    // when the period renews -- never part-way through it.
    expect(org.aiCredits.resetAt.getTime()).toBe(org.currentPeriodEnd.getTime());
  });
});
