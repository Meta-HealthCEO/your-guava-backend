const supertest = require('supertest');
const bcrypt = require('bcryptjs');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const PasswordResetToken = require('../../src/models/PasswordResetToken.model');
const { settleAfterResponse } = require('../../src/utils/afterResponse');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  await settleAfterResponse();
  jest.restoreAllMocks();
  await clearDB();
});

const registration = (email) => ({ name: 'Test Owner', email, password: 'password123', cafeName: 'Test Cafe' });
const shape = (res) => ({
  status: res.status,
  keys: Object.keys(res.body).sort(),
  message: res.body.message,
  code: res.body.code,
});

describe('register answers the same way for new, existing and pending emails', () => {
  it('returns one 202 body and emails the existing account holder instead', async () => {
    await createTestUser({ email: 'existing@yourguava.com' });
    jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({ sent: true });
    const notice = jest.spyOn(emailService, 'sendAccountExistsEmail').mockResolvedValue({ sent: true });
    await request.post('/api/auth/register').send(registration('pending@yourguava.com'));

    const fresh = await request.post('/api/auth/register').send(registration('fresh@yourguava.com'));
    const existing = await request.post('/api/auth/register').send(registration('existing@yourguava.com'));
    const pending = await request.post('/api/auth/register').send(registration('pending@yourguava.com'));

    expect(fresh.status).toBe(202);
    expect(shape(existing)).toEqual(shape(fresh));
    expect(shape(pending)).toEqual(shape(fresh));
    expect(existing.body.email).toBe('existing@yourguava.com');
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith({ user: { email: 'existing@yourguava.com' } });
    expect(await User.countDocuments({ email: 'existing@yourguava.com' })).toBe(1);
  });

  it('spends the same bcrypt work on an existing address as on a new one', async () => {
    await createTestUser({ email: 'existing@yourguava.com' });
    jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({ sent: true });
    jest.spyOn(emailService, 'sendAccountExistsEmail').mockResolvedValue({ sent: true });
    const hash = jest.spyOn(bcrypt, 'hash');
    await request.post('/api/auth/register').send(registration('fresh@yourguava.com'));
    const freshHashes = hash.mock.calls.length;
    hash.mockClear();
    await request.post('/api/auth/register').send(registration('existing@yourguava.com'));
    expect(freshHashes).toBe(1);
    expect(hash).toHaveBeenCalledTimes(freshHashes);
  });
});

describe('login does the same work for unknown and known emails', () => {
  it('runs a bcrypt compare against a dummy hash for an unknown email', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    const res = await request.post('/api/auth/login').send({ email: 'nobody@yourguava.com', password: 'password123' });
    expect(res.status).toBe(401);
    expect(compare).toHaveBeenCalledTimes(1);
  });
});

describe('forgot-password answers before it looks anything up', () => {
  it('returns the same 200 for known and unknown emails without awaiting the lookup', async () => {
    await createTestUser({ email: 'known@yourguava.com' });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const lookup = jest.spyOn(User, 'findOne').mockImplementation(() => ({
      select: () => ({ lean: () => gate.then(() => null) }),
    }));

    // Before this card the handler awaits the lookup, so the first request times out here.
    const known = await request.post('/api/auth/forgot-password').timeout(3000).send({ email: 'known@yourguava.com' });
    const unknown = await request.post('/api/auth/forgot-password').timeout(3000).send({ email: 'nobody@yourguava.com' });

    expect(known.status).toBe(200);
    expect(known.body).toEqual(unknown.body);
    release();
    await settleAfterResponse();
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('still issues and emails a reset token after answering', async () => {
    const owner = await createTestUser({ email: 'reset-later@yourguava.com' });
    const send = jest.spyOn(emailService, 'sendPasswordResetEmail').mockResolvedValue({ sent: true });
    const res = await request.post('/api/auth/forgot-password').send({ email: 'reset-later@yourguava.com' });
    expect(res.status).toBe(200);
    await settleAfterResponse();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await PasswordResetToken.countDocuments({ userId: owner.user.id, status: 'pending' })).toBe(1);
  });
});

describe('a non-string password is a 400 everywhere, never a 500', () => {
  it.each([[12345678], [true], [{ $gt: '' }], [['password123']]])('login with %p', async (password) => {
    await createTestUser({ email: 'typed@yourguava.com' });
    const known = await request.post('/api/auth/login').send({ email: 'typed@yourguava.com', password });
    const unknown = await request.post('/api/auth/login').send({ email: 'nobody@yourguava.com', password });
    expect(known.status).toBe(400);
    expect(unknown.status).toBe(400);
  });

  it('register, change-password, reset-password, accept-invitation and transfer-ownership', async () => {
    const owner = await createTestUser({ email: 'typed@yourguava.com' });
    const auth = { Authorization: `Bearer ${owner.token}` };
    const statuses = [
      (await request.post('/api/auth/register').send({ ...registration('new@yourguava.com'), password: 12345678 })).status,
      (await request.post('/api/auth/change-password').set(auth)
        .send({ currentPassword: 12345678, newPassword: 'newpassword456' })).status,
      (await request.post('/api/auth/change-password').set(auth)
        .send({ currentPassword: 'password123', newPassword: 12345678 })).status,
      (await request.post('/api/auth/reset-password').send({ token: 'a'.repeat(43), password: 12345678 })).status,
      (await request.post('/api/team/invitations/accept').send({ token: 'a'.repeat(43), password: 12345678 })).status,
      (await request.post('/api/team/transfer-ownership').set(auth)
        .send({ userId: '0123456789abcdef01234567', currentPassword: 12345678 })).status,
    ];
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400]);
  });

  it('comparePassword resolves false for a non-string candidate instead of throwing', async () => {
    const owner = await createTestUser({ email: 'model@yourguava.com' });
    const user = await User.findById(owner.user.id).select('+password');
    await expect(user.comparePassword(12345678)).resolves.toBe(false);
  });
});

describe('team invite does not name an existing account', () => {
  it('answers a neutral 409 for an address that already has an account', async () => {
    await createTestUser({ email: 'customer@yourguava.com' });
    const owner = await createTestUser({ email: 'prober@yourguava.com' });
    jest.spyOn(emailService, 'sendTeamInviteEmail').mockResolvedValue({ sent: true });
    const res = await request.post('/api/team/invite').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Probe Target', email: 'customer@yourguava.com', cafeIds: [owner.user.activeCafeId] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('INVITE_NOT_POSSIBLE');
    expect(res.body.message).not.toMatch(/registered|account|already use/i);
  });

  it('checks cafe access before it looks the address up', async () => {
    await createTestUser({ email: 'customer@yourguava.com' });
    const owner = await createTestUser({ email: 'prober@yourguava.com' });
    const res = await request.post('/api/team/invite').set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'Probe Target', email: 'customer@yourguava.com', cafeIds: ['0123456789abcdef01234567'] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cafe access/i);
  });
});
