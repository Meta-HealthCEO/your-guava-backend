const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const User = require('../../src/models/User.model');
const Staff = require('../../src/models/Staff.model');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const { createOAuthState, verifyOAuthState } = require('../../src/services/yoco.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
beforeEach(() => {
  // Ensure a stray local .env value never leaks into webhook tests
  delete process.env.YOCO_INTEGRATION_ENABLED;
  delete process.env.YOCO_WEBHOOK_SECRET;
});
afterEach(async () => {
  jest.restoreAllMocks();
  delete process.env.YOCO_INTEGRATION_ENABLED;
  delete process.env.YOCO_WEBHOOK_SECRET;
  await clearDB();
});

describe('Legacy Yoco API surface', () => {
  it('does not expose the webhook route unless explicitly enabled', async () => {
    const res = await request.post('/api/yoco/webhook').send({ event_type: 'payment.created' });
    expect(res.status).toBe(404);
  });

  it('does not expose the OAuth callback route unless explicitly enabled', async () => {
    const { token } = await createTestUser();
    const res = await request
      .post('/api/yoco/callback')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'auth-code', state: 'forged-state' });
    expect(res.status).toBe(404);
  });
});

describe('Yoco OAuth state', () => {
  it('round-trips a valid state for the same cafe', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(state, 'cafe123')).toBe(true);
  });

  it('rejects state bound to a different cafe', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(state, 'othercafe')).toBe(false);
  });

  it('rejects tampered and malformed state', () => {
    const state = createOAuthState('cafe123');
    expect(verifyOAuthState(`${state}x`, 'cafe123')).toBe(false);
    expect(verifyOAuthState('garbage', 'cafe123')).toBe(false);
    expect(verifyOAuthState(undefined, 'cafe123')).toBe(false);
  });

});

describe('Refresh token rotation', () => {
  it('rotates the refresh cookie and keeps the stored list bounded', async () => {
    const { user, cookie } = await createTestUser();

    const res = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeDefined();

    const newCookie = res.headers['set-cookie'];
    expect(newCookie).toBeDefined();
    expect(String(newCookie)).toContain('refreshToken=');

    const persisted = await User.findById(user.id);
    expect(persisted.refreshTokens.length).toBeLessThanOrEqual(10);

    // Run many refreshes — the list must stay bounded
    let currentCookie = newCookie;
    for (let i = 0; i < 12; i++) {
      const r = await request.post('/api/auth/refresh').set('Cookie', currentCookie);
      expect(r.status).toBe(200);
      currentCookie = r.headers['set-cookie'] || currentCookie;
    }
    const after = await User.findById(user.id);
    expect(after.refreshTokens.length).toBeLessThanOrEqual(10);
  });

  it('invalidates the consumed refresh token after rotation (no replay)', async () => {
    const { cookie } = await createTestUser();

    // First refresh succeeds and rotates the token
    const first = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(first.status).toBe(200);

    // Replaying the ORIGINAL (now consumed) cookie must be rejected
    const replay = await request.post('/api/auth/refresh').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    // The freshly issued cookie still works
    const next = await request.post('/api/auth/refresh').set('Cookie', first.headers['set-cookie']);
    expect(next.status).toBe(200);
  });
});

describe('Profile RBAC', () => {
  it('blocks managers from changing organization details', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    const res = await request
      .patch('/api/account/profile')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ organizationName: 'Hijacked Org', billingEmail: 'evil@example.com' });

    expect(res.status).toBe(403);
    const org = await Organization.findById(owner.user.orgId);
    expect(org.name).not.toBe('Hijacked Org');
  });

  it('still allows managers to update their own name', async () => {
    const owner = await createTestUser();
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);

    const res = await request
      .patch('/api/account/profile')
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ name: 'Renamed Manager' });

    expect(res.status).toBe(200);
    const persisted = await User.findById(manager.user.id);
    expect(persisted.name).toBe('Renamed Manager');
  });
});

describe('Cross-tenant staff scoping', () => {
  it('rejects shifts referencing another cafe\'s staff', async () => {
    const owner = await createTestUser();
    const otherCafe = await Cafe.create({ name: 'Other Cafe', orgId: owner.user.orgId });
    const foreignStaff = await Staff.create({
      cafeId: otherCafe._id,
      name: 'Foreign Staff',
      role: 'barista',
      hourlyRate: 50,
    });

    const res = await request
      .post('/api/shifts')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        staffId: foreignStaff._id.toString(),
        date: '2026-06-15',
        startTime: '08:00',
        endTime: '16:00',
      });

    expect(res.status).toBe(404);
  });

  it('rejects leave requests referencing another cafe\'s staff', async () => {
    const owner = await createTestUser();
    const otherCafe = await Cafe.create({ name: 'Other Cafe', orgId: owner.user.orgId });
    const foreignStaff = await Staff.create({
      cafeId: otherCafe._id,
      name: 'Foreign Staff',
      role: 'barista',
      hourlyRate: 50,
    });

    const res = await request
      .post('/api/leave')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        staffId: foreignStaff._id.toString(),
        type: 'annual',
        startDate: '2026-06-15',
        endDate: '2026-06-16',
      });

    expect(res.status).toBe(404);
  });
});
