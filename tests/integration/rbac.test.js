const supertest = require('supertest');
const jwt = require('jsonwebtoken');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const { RBAC_TABLE } = require('../fixtures/rbacTable');

const request = supertest(app);
const SOME_ID = '0123456789abcdef01234567';
const concretePath = (route) => route.replace(':provider', 'xero').replace(/:[A-Za-z]+/g, SOME_ID);
const call = (method, route, token) =>
  request[method.toLowerCase()](concretePath(route)).set('Authorization', `Bearer ${token}`).send({});

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

// Yoco routes are mounted only when YOCO_INTEGRATION_ENABLED=true (never in tests); rbacTable.test.js covers them structurally.
const mounted = ([, route]) => !route.startsWith('/api/yoco');
const ownerRows = RBAC_TABLE.filter((row) => row[2] === 'owner' && mounted(row));
const creditRows = RBAC_TABLE.filter((row) => row[2] === 'credit' && mounted(row));

describe('managers are refused every owner-only route', () => {
  let manager;
  beforeEach(async () => {
    const owner = await createTestUser();
    manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
  });

  it.each(ownerRows)('%s %s -> 403 for a manager', async (method, route) => {
    const res = await call(method, route, manager.token);
    expect(res.status).toBe(403);
  });

  it.each(creditRows)('%s %s -> 403 for a manager without credit permission', async (method, route) => {
    const res = await call(method, route, manager.token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CREDIT_SPEND_FORBIDDEN');
  });

  it('still lets a manager read the forecast factors and upload list', async () => {
    expect((await request.get('/api/forecasts/factors').set('Authorization', `Bearer ${manager.token}`)).status).toBe(200);
    expect((await request.get('/api/uploads').set('Authorization', `Bearer ${manager.token}`)).status).toBe(200);
  });
});

describe('session cafe', () => {
  const tokenWithoutCafe = (user) => jwt.sign(
    { id: user.id, cafeId: null, role: user.role, orgId: String(user.orgId), tokenVersion: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );

  it('rejects a token with a null cafeId for a user who has cafes (401)', async () => {
    const owner = await createTestUser();
    const res = await request.get('/api/cafe/me').set('Authorization', `Bearer ${tokenWithoutCafe(owner.user)}`);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/session expired/i);
  });

  it('keeps a user with no cafes signed in, and answers analytics with 400 CAFE_REQUIRED instead of a 500', async () => {
    const owner = await createTestUser();
    await User.updateOne({ _id: owner.user.id }, { $set: { cafeIds: [], activeCafeId: null } });
    const token = tokenWithoutCafe(owner.user);
    expect((await request.get('/api/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request.get('/api/account').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    for (const endpoint of ['revenue', 'items', 'heatmap', 'customers', 'combos']) {
      const res = await request.get(`/api/analytics/${endpoint}`).set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('CAFE_REQUIRED');
    }
  });
});
