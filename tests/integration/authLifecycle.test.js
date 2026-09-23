const supertest = require('supertest');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { setup, teardown, clearDB, createTestUser, createTestManager, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const AuthSession = require('../../src/models/AuthSession.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const { settleAfterResponse } = require('../../src/utils/afterResponse');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  await settleAfterResponse();
  jest.restoreAllMocks();
  await clearDB();
});

describe('A. a lost refresh response inside the grace window never signs the user out', () => {
  it('reissues the same replacement to the old cookie for up to two minutes', async () => {
    const owner = await createTestUser({ email: 'flaky@yourguava.com' });
    const first = await request.post('/api/auth/refresh').set('Cookie', owner.cookie);
    expect(first.status).toBe(200);
    const session = await AuthSession.findOne({ userId: owner.user.id, revokedAt: null }).lean();
    expect(session.previousValidUntil.getTime() - Date.now()).toBeGreaterThan(110_000);

    // Ninety seconds later the browser still holds the old cookie because the response was lost.
    await AuthSession.updateOne({ _id: session._id }, { $set: { previousValidUntil: new Date(Date.now() + 30_000) } });
    const retry = await request.post('/api/auth/refresh').set('Cookie', owner.cookie);
    expect(retry.status).toBe(200);
    // Compare the token, not the whole header: the cookie's Expires attribute is recomputed per response.
    const refreshTokenOf = (res) => String(res.headers['set-cookie']).match(/refreshToken=([^;]+)/)[1];
    expect(refreshTokenOf(retry)).toBe(refreshTokenOf(first));
  });

  it('still treats the old token as a replay once the replacement was used, and audits it once', async () => {
    const owner = await createTestUser({ email: 'replay@yourguava.com' });
    const first = await request.post('/api/auth/refresh').set('Cookie', owner.cookie);
    expect((await request.post('/api/auth/refresh').set('Cookie', first.headers['set-cookie'])).status).toBe(200);
    expect((await request.post('/api/auth/refresh').set('Cookie', owner.cookie)).status).toBe(401);
    expect((await request.post('/api/auth/refresh').set('Cookie', owner.cookie)).status).toBe(401);
    expect(await AccessAuditEvent.countDocuments({ action: 'session.reuse_detected', targetEmail: 'replay@yourguava.com' })).toBe(1);
  });
});

describe('B. audit pagination has a tie-break', () => {
  it('pages through events that share a timestamp without skipping any', async () => {
    const owner = await createTestUser({ email: 'audit@yourguava.com' });
    const at = new Date('2026-09-20T10:00:00.000Z');
    await AccessAuditEvent.collection.insertMany([1, 2, 3].map((n) => ({
      orgId: new mongoose.Types.ObjectId(String(owner.user.orgId)),
      action: 'member.updated',
      targetEmail: `m${n}@yourguava.com`,
      details: {},
      createdAt: at,
      updatedAt: at,
    })));
    const seen = [];
    let query = { limit: 2 };
    for (let guard = 0; guard < 5; guard += 1) {
      const res = await request.get('/api/team/audit-events').query(query).set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.events.map((event) => event.targetEmail));
      if (!res.body.pagination.hasMore) break;
      query = { limit: 2, before: res.body.pagination.nextBefore, beforeId: res.body.pagination.nextBeforeId };
    }
    expect(seen.sort()).toEqual(['m1@yourguava.com', 'm2@yourguava.com', 'm3@yourguava.com']);
  });

  it('rejects a malformed cursor with 400', async () => {
    const owner = await createTestUser({ email: 'cursor@yourguava.com' });
    const res = await request.get('/api/team/audit-events')
      .query({ before: '2026-09-20T10:00:00.000Z', beforeId: 'not-an-id' })
      .set('Authorization', `Bearer ${owner.token}`);
    expect(res.status).toBe(400);
  });
});

describe('C. invitation lookups by email are indexed', () => {
  it('finds pending invitations by email through an index', async () => {
    const owner = await createTestUser({ email: 'index-owner@yourguava.com' });
    await TeamInvitation.init();
    const base = { orgId: owner.user.orgId, invitedByUserId: owner.user.id, name: 'Invitee', cafeIds: [owner.user.activeCafeId] };
    await TeamInvitation.insertMany(Array.from({ length: 30 }, (_, n) => ({
      ...base,
      email: `invitee${n}@yourguava.com`,
      tokenHash: String(n).padStart(64, '0'),
      status: n % 3 === 0 ? 'pending' : 'revoked',
      expiresAt: new Date(Date.now() + 86_400_000),
    })));
    const explained = await TeamInvitation.find({
      email: 'invitee3@yourguava.com',
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).explain('executionStats');
    const doc = Array.isArray(explained) ? explained[0] : explained;
    expect(JSON.stringify(doc.queryPlanner.winningPlan)).toContain('"indexName":"email_1_status_1_expiresAt_1"');
    expect(doc.executionStats.totalDocsExamined).toBe(doc.executionStats.nReturned);
  });
});

describe('D. security events are audited and emailed', () => {
  it('emails the account holder after a password change and after a reset', async () => {
    const owner = await createTestUser({ email: 'notice@yourguava.com' });
    const notice = jest.spyOn(emailService, 'sendSecurityNoticeEmail').mockResolvedValue({ sent: true });
    await request.post('/api/auth/change-password').set('Authorization', `Bearer ${owner.token}`)
      .send({ currentPassword: 'password123', newPassword: 'newpassword456' });
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'password_changed',
      user: expect.objectContaining({ email: 'notice@yourguava.com' }),
    }));

    let resetToken;
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async ({ resetToken: token }) => {
      resetToken = token;
      return { sent: true };
    });
    await request.post('/api/auth/forgot-password').send({ email: 'notice@yourguava.com' });
    await settleAfterResponse();
    await request.post('/api/auth/reset-password').send({ token: resetToken, password: 'resetpassword789' });
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'password_reset' }));
    expect(await AccessAuditEvent.countDocuments({ action: 'password.changed' })).toBe(1);
    expect(await AccessAuditEvent.countDocuments({ action: 'password.reset' })).toBe(1);
  });

  it('emails both people when ownership is transferred', async () => {
    const owner = await createTestUser({ email: 'old-owner@yourguava.com' });
    const manager = await createTestManager(owner.token, [owner.user.activeCafeId]);
    const notice = jest.spyOn(emailService, 'sendSecurityNoticeEmail').mockResolvedValue({ sent: true });
    const res = await request.post('/api/team/transfer-ownership').set('Authorization', `Bearer ${owner.token}`)
      .send({ userId: manager.user.id, currentPassword: 'password123' });
    expect(res.status).toBe(200);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ownership_transferred_away', user: expect.objectContaining({ email: 'old-owner@yourguava.com' }),
    }));
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'ownership_received', user: expect.objectContaining({ email: 'manager@yourguava.com' }),
    }));
  });

  it('audits organisation renames and billing-email changes', async () => {
    const owner = await createTestUser({ email: 'profile@yourguava.com' });
    const res = await request.patch('/api/account/profile').set('Authorization', `Bearer ${owner.token}`)
      .send({ organizationName: 'Renamed Org', billingEmail: 'accounts@cafe.co.za' });
    expect(res.status).toBe(200);
    const renamed = await AccessAuditEvent.findOne({ action: 'org.renamed' }).lean();
    expect(renamed.details).toEqual({ from: 'Test Org', to: 'Renamed Org' });
    const billing = await AccessAuditEvent.findOne({ action: 'org.billing_email_changed' }).lean();
    expect(billing.details).toEqual({ from: 'profile@yourguava.com', to: 'accounts@cafe.co.za' });
  });
});

describe('G. one bcrypt cost, and no throwaway hash', () => {
  it('hashes register and model passwords with BCRYPT_ROUNDS', async () => {
    const previous = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = '5';
    try {
      jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({ sent: true });
      await request.post('/api/auth/register')
        .send({ name: 'Rounds Owner', email: 'rounds@yourguava.com', password: 'password123', cafeName: 'Rounds Cafe' });
      const pending = await PendingRegistration.findOne({ email: 'rounds@yourguava.com' }).select('+passwordHash').lean();
      expect(pending.passwordHash).toMatch(/^\$2[aby]\$05\$/);
      const direct = await User.create({ name: 'Direct User', email: 'direct@yourguava.com', password: 'password123' });
      expect((await User.findById(direct._id).select('+password').lean()).password).toMatch(/^\$2[aby]\$05\$/);
    } finally {
      if (previous === undefined) delete process.env.BCRYPT_ROUNDS;
      else process.env.BCRYPT_ROUNDS = previous;
    }
  });

  it('stores the pending hash as the password without hashing anything during verification', async () => {
    let token;
    jest.spyOn(emailService, 'sendVerificationEmail').mockImplementation(async ({ verificationToken }) => {
      token = verificationToken;
      return { sent: true };
    });
    await request.post('/api/auth/register')
      .send({ name: 'Verify Owner', email: 'verify@yourguava.com', password: 'password123', cafeName: 'Verify Cafe' });
    const pending = await PendingRegistration.findOne({ email: 'verify@yourguava.com' }).select('+passwordHash').lean();
    const hash = jest.spyOn(bcrypt, 'hash');
    expect((await request.post('/api/auth/verify-email').send({ token, password: 'password123' })).status).toBe(201);
    // bcryptjs implements compare() by hashing the candidate with the stored salt, so the one hash call is BE-02-T01's
    // password check (salt argument = the pending hash's prefix); a throwaway or re-hash would pass a numeric cost instead.
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash.mock.calls.every(([, salt]) => typeof salt === 'string' && pending.passwordHash.startsWith(salt))).toBe(true);
    expect((await User.findOne({ email: 'verify@yourguava.com' }).select('+password').lean()).password).toBe(pending.passwordHash);
    expect((await request.post('/api/auth/login').send({ email: 'verify@yourguava.com', password: 'password123' })).status).toBe(200);
  });
});
