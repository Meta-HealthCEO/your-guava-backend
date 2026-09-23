const supertest = require('supertest');
const bcrypt = require('bcryptjs');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const AuthThrottle = require('../../src/models/AuthThrottle.model');
const authThrottle = require('../../src/services/authThrottle.service');
const { settleAfterResponse } = require('../../src/utils/afterResponse');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  await settleAfterResponse();
  jest.restoreAllMocks();
  await clearDB();
});

const login = (email, password, ip = '198.51.100.10') =>
  request.post('/api/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('per-account login throttle', () => {
  it('refuses the 6th failed login for one account within 15 minutes regardless of IP, even with the right password', async () => {
    await createTestUser({ email: 'throttle@yourguava.com' });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await login('throttle@yourguava.com', 'wrong-password', `198.51.100.${attempt}`)).status).toBe(401);
    }
    const sixth = await login('throttle@yourguava.com', 'password123', '203.0.113.77');
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('LOGIN_THROTTLED');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(sixth.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(sixth.body.message).toMatch(/try again in 1 minute/i);
  });

  it('does not run bcrypt for a refused attempt', async () => {
    await createTestUser({ email: 'nobcrypt@yourguava.com' });
    for (let attempt = 1; attempt <= 5; attempt += 1) await login('nobcrypt@yourguava.com', 'wrong-password');
    const compare = jest.spyOn(bcrypt, 'compare');
    expect((await login('nobcrypt@yourguava.com', 'wrong-password')).status).toBe(429);
    expect(compare).not.toHaveBeenCalled();
  });

  it('clears the count after a successful login', async () => {
    await createTestUser({ email: 'clears@yourguava.com' });
    for (let i = 0; i < 4; i += 1) await login('clears@yourguava.com', 'wrong-password');
    expect((await login('clears@yourguava.com', 'password123')).status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await login('clears@yourguava.com', 'wrong-password')).status).toBe(401);
    expect((await login('clears@yourguava.com', 'password123')).status).toBe(200);
  });

  it('throttles an unknown address exactly like a real one, without storing the address', async () => {
    for (let i = 0; i < 5; i += 1) expect((await login('ghost@yourguava.com', 'wrong-password')).status).toBe(401);
    expect((await login('ghost@yourguava.com', 'wrong-password')).status).toBe(429);
    const record = await AuthThrottle.findOne({ bucket: 'login' }).lean();
    expect(record.count).toBe(5);
    expect(record._id).not.toContain('ghost');
    expect(record._id).toMatch(/^login:[a-f0-9]{64}$/);
  });

  it('backs off 60 s after the fifth failure, doubles per further failure, caps at 15 minutes and resets after the window', async () => {
    const email = 'backoff@yourguava.com';
    const t0 = new Date('2026-09-23T08:00:00.000Z');
    for (let i = 0; i < 4; i += 1) expect((await authThrottle.recordLoginFailure(email, t0)).blockedUntil).toBeNull();
    const fifth = await authThrottle.recordLoginFailure(email, t0);
    expect(fifth.blockedUntil.getTime() - t0.getTime()).toBe(60_000);
    expect((await authThrottle.loginGate(email, new Date(t0.getTime() + 59_000))).allowed).toBe(false);
    expect((await authThrottle.loginGate(email, new Date(t0.getTime() + 61_000))).allowed).toBe(true);

    const t1 = new Date(t0.getTime() + 61_000);
    expect((await authThrottle.recordLoginFailure(email, t1)).blockedUntil.getTime() - t1.getTime()).toBe(120_000);
    let latest;
    for (let i = 0; i < 5; i += 1) latest = await authThrottle.recordLoginFailure(email, t1);
    expect(latest.blockedUntil.getTime() - t1.getTime()).toBe(15 * 60_000);

    const fresh = await authThrottle.recordLoginFailure(email, new Date(t0.getTime() + 16 * 60_000));
    expect(fresh.count).toBe(1);
    expect(fresh.blockedUntil).toBeNull();
  });
});

describe('per-recipient email cooldown', () => {
  it('sends at most 3 password-reset emails to one recipient per hour', async () => {
    await createTestUser({ email: 'bombed@yourguava.com' });
    const send = jest.spyOn(emailService, 'sendPasswordResetEmail').mockResolvedValue({ sent: true });
    for (let i = 0; i < 5; i += 1) {
      expect((await request.post('/api/auth/forgot-password').send({ email: 'bombed@yourguava.com' })).status).toBe(200);
    }
    await settleAfterResponse();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('counts unknown addresses the same way, so the quota reveals nothing', async () => {
    for (let i = 0; i < 4; i += 1) {
      await request.post('/api/auth/forgot-password').send({ email: 'ghost@yourguava.com' });
    }
    await settleAfterResponse();
    const record = await AuthThrottle.findOne({ bucket: 'email_password_reset' }).lean();
    expect(record.count).toBe(4);
    expect(record._id).not.toContain('ghost');
  });

  it('caps verification emails per recipient across register and resend and leaves the pending signup alone when over', async () => {
    const send = jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({ sent: true });
    const body = { name: 'Quota Owner', email: 'quota@yourguava.com', password: 'password123', cafeName: 'Quota Cafe' };
    expect((await request.post('/api/auth/register').send(body)).status).toBe(202);
    for (let i = 0; i < 3; i += 1) {
      await request.post('/api/auth/resend-verification').send({ email: 'quota@yourguava.com' });
    }
    await settleAfterResponse();
    const overQuota = await request.post('/api/auth/register').send({ ...body, password: 'another-password-1' });
    expect(overQuota.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(3);
    const pending = await PendingRegistration.findOne({ email: 'quota@yourguava.com' }).select('+passwordHash').lean();
    await expect(bcrypt.compare('password123', pending.passwordHash)).resolves.toBe(true);
  });

  it('survives a restart: the counter is a Mongo document with a TTL', async () => {
    expect(AuthThrottle.schema.indexes()).toEqual(expect.arrayContaining([
      [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
    ]));
  });
});
