const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Account API', () => {
  let ownerToken;
  let ownerUser;

  beforeEach(async () => {
    const testUser = await createTestUser();
    ownerToken = testUser.token;
    ownerUser = testUser.user;
  });

  it('returns account plan, seat, location, and AI credit usage', async () => {
    const res = await request
      .get('/api/account')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.account.organization.plan).toBe('starter');
    expect(res.body.account.usage.seats.used).toBe(1);
    expect(res.body.account.usage.aiCredits.available).toBeGreaterThan(0);
    expect(res.body.account.plans.map((plan) => plan.id)).toEqual(['starter', 'growth', 'pro']);
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

  it('mock checkout changes plan and resets included AI credits', async () => {
    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ plan: 'growth', billingCycle: 'annual' });

    expect(res.status).toBe(200);
    expect(res.body.checkout.provider).toBe('mock');
    expect(res.body.account.organization.plan).toBe('growth');
    expect(res.body.account.organization.billingCycle).toBe('annual');
    expect(res.body.account.usage.aiCredits.included).toBe(600);
  });

  it('only owners can change billing', async () => {
    const manager = await createTestManager(ownerToken, [ownerUser.activeCafeId]);

    const res = await request
      .post('/api/account/checkout')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ plan: 'growth' });

    expect(res.status).toBe(403);
  });

  it('adds mock AI credit packs', async () => {
    const res = await request
      .post('/api/account/ai-credits')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ credits: 250 });

    expect(res.status).toBe(200);
    expect(res.body.purchase.credits).toBe(250);
    expect(res.body.account.usage.aiCredits.bonus).toBe(250);
  });
});
