const {
  setup,
  teardown,
  clearDB,
  createTestUser,
} = require('../setup');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const {
  meterGuavaCredits,
  reconcileStaleUsageReservations,
} = require('../../src/services/usage.service');

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const waitFor = async (probe, attempts = 200) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the expected state');
};

describe('metered Guava Credit amounts', () => {
  it('refuses a credit amount that is not a non-negative number', async () => {
    const owner = await createTestUser();
    const run = jest.fn(async () => ({ answer: 'no' }));

    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: -1,
        run,
      })
    ).rejects.toThrow(/non-negative/i);
    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: 'three',
        run,
      })
    ).rejects.toThrow(/non-negative/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('still gates a zero-cost feature on billing access', async () => {
    const owner = await createTestUser();
    await Organization.updateOne(
      { _id: owner.user.orgId },
      { $set: { billingStatus: 'past_due', trialEndsAt: new Date(Date.now() - 60_000) } }
    );
    const run = jest.fn(async () => ({ answer: 'free' }));

    await expect(
      meterGuavaCredits({
        orgId: owner.user.orgId,
        userId: owner.user.id,
        featureKey: 'ask_guava_chat',
        credits: 0,
        run,
      })
    ).rejects.toMatchObject({ statusCode: 402, code: 'BILLING_REQUIRED' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('Guava Credit reservation lease breach', () => {
  it('keeps the delivered answer and re-charges when the reconciler refunded mid-run', async () => {
    const owner = await createTestUser();
    let finishRun;
    const metered = meterGuavaCredits({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      featureKey: 'ask_guava_chat',
      idempotencyKey: 'lease-breach-request',
      run: () => new Promise((resolve) => { finishRun = resolve; }),
    });

    const reserved = await waitFor(() =>
      UsageLedger.findOne({ orgId: owner.user.orgId, status: 'reserved' }).lean()
    );
    // The run outlives its lease and the reconciler releases the hold.
    await UsageLedger.updateOne(
      { _id: reserved._id },
      { $set: { reservedAt: new Date(Date.now() - 10 * 60_000) } }
    );
    const recovery = await reconcileStaleUsageReservations({ leaseMs: 60_000 });
    expect(recovery.refunded).toBe(1);

    finishRun({ answer: 'delivered anyway' });
    const outcome = await metered;

    expect(outcome.result).toEqual({ answer: 'delivered anyway' });
    const settled = await UsageLedger.findById(reserved._id).lean();
    expect(settled.status).toBe('committed');
    expect(settled.resultPayload).toEqual({ answer: 'delivered anyway' });
    expect(settled.recoveryReason).toBe('lease_breach_recommitted');
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });

  it('charges exactly once when the reconciler and the commit race', async () => {
    const owner = await createTestUser();
    let finishRun;
    const metered = meterGuavaCredits({
      orgId: owner.user.orgId,
      userId: owner.user.id,
      featureKey: 'ask_guava_chat',
      idempotencyKey: 'lease-breach-race',
      run: () => new Promise((resolve) => { finishRun = resolve; }),
    });

    const reserved = await waitFor(() =>
      UsageLedger.findOne({ orgId: owner.user.orgId, status: 'reserved' }).lean()
    );
    await UsageLedger.updateOne(
      { _id: reserved._id },
      { $set: { reservedAt: new Date(Date.now() - 10 * 60_000) } }
    );

    // Whichever side wins the row, the customer is charged for the answer once:
    // never twice, and never not at all.
    const recovery = reconcileStaleUsageReservations({ leaseMs: 60_000 });
    finishRun({ answer: 'raced' });
    const [outcome] = await Promise.all([metered, recovery]);

    expect(outcome.result).toEqual({ answer: 'raced' });
    const settled = await UsageLedger.findById(reserved._id).lean();
    expect(settled.status).toBe('committed');
    expect(settled.resultPayload).toEqual({ answer: 'raced' });
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });
});
