const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.PAYMENT_PROVIDER;
  delete process.env.ONEGATE_API_URL;
  delete process.env.ONEGATE_ORGANISATION_ID;
  delete process.env.ONEGATE_ORG_ID;
  delete process.env.ONEGATE_API_SALT;
  delete process.env.API_PUBLIC_URL;
  delete process.env.BILLING_MOCK_ENABLED;
  await clearDB();
});

describe('Account API', () => {
  let ownerToken;
  let ownerUser;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;
  });

  it('returns account plan, seat, location, and Guava Credit usage', async () => {
    const res = await request
      .get('/api/account')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.account.organization.plan).toBe('starter');
    expect(res.body.account.usage.seats.used).toBe(1);
    expect(res.body.account.usage.guavaCredits.available).toBeGreaterThan(0);
    expect(res.body.account.usage.creditLedger).toEqual(
      expect.objectContaining({ byFeature: expect.any(Array), recent: expect.any(Array) })
    );
    expect(res.body.account.plans.map((plan) => plan.id)).toEqual(['starter', 'growth', 'pro']);
  });

  it('returns a lightweight Guava Credit balance for the app toolbar', async () => {
    const res = await request
      .get('/api/account/credits')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.credits).toEqual(
      expect.objectContaining({
        included: expect.any(Number),
        bonus: expect.any(Number),
        used: expect.any(Number),
        available: expect.any(Number),
      })
    );
    expect(res.body.organization).toEqual(
      expect.objectContaining({ plan: 'starter', billingStatus: 'trialing' })
    );
    expect(res.body.plan).toEqual(
      expect.objectContaining({ id: 'starter', name: 'Starter', includedGuavaCredits: expect.any(Number) })
    );
    expect(res.body.account).toBeUndefined();
  });

  it('updates profile and organisation billing details', async () => {
    const res = await request
      .patch('/api/account/profile')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Updated Owner',
        organizationName: 'Updated Org',
        billingEmail: 'billing@yourguava.com',
      });

    expect(res.status).toBe(200);
    expect(res.body.account.user.name).toBe('Updated Owner');
    expect(res.body.account.organization.name).toBe('Updated Org');
    expect(res.body.account.organization.billingEmail).toBe('billing@yourguava.com');
  });

  it('mock checkout changes plan and resets included Guava Credits', async () => {
    const Forecast = require('../../src/models/Forecast.model');
    await request.get('/api/forecasts/week').set('Authorization', `Bearer ${ownerToken}`);
    expect(await Forecast.countDocuments({})).toBe(7);

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'growth', billingCycle: 'annual' });

    expect(res.status).toBe(200);
    expect(res.body.checkout.provider).toBe('mock');
    expect(res.body.account.organization.plan).toBe('growth');
    expect(res.body.account.organization.billingCycle).toBe('annual');
    expect(res.body.account.usage.guavaCredits.included).toBe(1800);
    expect(await Forecast.countDocuments({})).toBe(0);
  });

  it('does not allow mock checkout in production', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.BILLING_MOCK_ENABLED = 'true';

    try {
      const res = await request
        .post('/api/account/checkout')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ plan: 'growth', billingCycle: 'monthly' });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('BILLING_PROVIDER_NOT_CONFIGURED');
    } finally {
      if (savedNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('creates a hosted OneGate card checkout without activating the plan before payment', async () => {
    const oneGate = require('../../src/services/onegate.service');
    const PaymentSession = require('../../src/models/PaymentSession.model');

    process.env.PAYMENT_PROVIDER = 'onegate';
    process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
    process.env.ONEGATE_ORGANISATION_ID = '21234';
    process.env.ONEGATE_API_SALT = 'test-salt';
    process.env.API_PUBLIC_URL = 'http://api.test';

    jest.spyOn(oneGate, 'createPaymentKey').mockResolvedValue({
      key: 'pay_key_123',
      url: 'https://payments.onegate.co.za/pay/hosted?payment_key=pay_key_123&payment_type=credit_card',
      origin: 'https://payments.onegate.co.za',
    });

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'growth', billingCycle: 'monthly' });

    expect(res.status).toBe(200);
    expect(res.body.checkout.provider).toBe('onegate');
    expect(res.body.checkout.status).toBe('pending');
    expect(res.body.checkout.redirectUrl).toContain('/pay/hosted');
    expect(res.body.account.organization.plan).toBe('starter');

    const session = await PaymentSession.findOne({ reference: res.body.checkout.reference }).lean();
    expect(session).toEqual(
      expect.objectContaining({
        provider: 'onegate',
        kind: 'plan',
        status: 'pending',
        plan: 'growth',
        amount: 899,
      })
    );
  });

  it('activates a OneGate plan payment after webhook verification', async () => {
    const oneGate = require('../../src/services/onegate.service');
    const Organization = require('../../src/models/Organization.model');
    const PaymentSession = require('../../src/models/PaymentSession.model');

    process.env.PAYMENT_PROVIDER = 'onegate';
    process.env.ONEGATE_API_URL = 'https://payments.onegate.co.za';
    process.env.ONEGATE_ORGANISATION_ID = '21234';
    process.env.ONEGATE_API_SALT = 'test-salt';
    process.env.API_PUBLIC_URL = 'http://api.test';

    jest.spyOn(oneGate, 'createPaymentKey').mockResolvedValue({
      key: 'pay_key_456',
      url: 'https://payments.onegate.co.za/pay/hosted?payment_key=pay_key_456&payment_type=credit_card',
      origin: 'https://payments.onegate.co.za',
    });

    const checkout = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'growth', billingCycle: 'monthly' });

    const reference = checkout.body.checkout.reference;
    jest.spyOn(oneGate, 'lookupGatewayTransaction').mockResolvedValue({
      id: 1356875,
      successful: 1,
      status: 'complete',
      amount: '899.00',
      currency: 'ZAR',
      merchant_reference: reference,
      gateway_reference: 'gateway_ref_123',
      gateway_response_parameters: {
        card: '422998*****0012',
        cardName: 'Visa',
      },
    });

    const webhook = await request
      .post('/api/account/payments/onegate/notify')
      .send({ merchant_reference: reference, success: 1 });

    expect(webhook.status).toBe(200);

    const org = await Organization.findById(ownerUser.orgId).lean();
    expect(org.plan).toBe('growth');
    expect(org.billingStatus).toBe('active');
    expect(org.paymentMethod).toEqual(
      expect.objectContaining({ provider: 'onegate', brand: 'visa', last4: '0012' })
    );

    const session = await PaymentSession.findOne({ reference }).lean();
    expect(session.status).toBe('paid');
    expect(session.gatewayReference).toBe('gateway_ref_123');
  });

  it('only owners can change billing', async () => {
    const manager = await createTestManager(ownerToken, [ownerUser.activeCafeId]);

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ plan: 'growth' });

    expect(res.status).toBe(403);
  });

  it('adds mock Guava Credit packs', async () => {
    const res = await request
      .post('/api/account/ai-credits')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ credits: 500 });

    expect(res.status).toBe(200);
    expect(res.body.purchase.credits).toBe(500);
    expect(res.body.account.usage.guavaCredits.bonus).toBe(500);
  });

  it('does not allow mock credit purchases in production', async () => {
    const savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.BILLING_MOCK_ENABLED = 'true';

    try {
      const res = await request
        .post('/api/account/ai-credits')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ credits: 500 });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('BILLING_PROVIDER_NOT_CONFIGURED');
    } finally {
      if (savedNodeEnv == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedNodeEnv;
    }
  });

  it('summarises metered Guava Credit activity', async () => {
    const { consumeGuavaCredits } = require('../../src/services/usage.service');
    await consumeGuavaCredits(ownerUser.orgId, 3, {
      featureKey: 'ask_guava_chat',
      label: 'Ask Guava answer',
      provider: 'anthropic',
      cafeId: ownerUser.activeCafeId,
      userId: ownerUser.id,
    });

    const res = await request
      .get('/api/account')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.account.usage.guavaCredits.used).toBe(3);
    expect(res.body.account.usage.creditLedger.byFeature).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ featureKey: 'ask_guava_chat', credits: 3, count: 1 }),
      ])
    );
    expect(res.body.account.usage.creditLedger.recent[0]).toEqual(
      expect.objectContaining({ featureKey: 'ask_guava_chat', credits: 3 })
    );
  });
});
