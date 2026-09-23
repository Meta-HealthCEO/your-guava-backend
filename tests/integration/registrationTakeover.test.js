const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const TeamInvitation = require('../../src/models/TeamInvitation.model');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const { settleAfterResponse } = require('../../src/utils/afterResponse');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const payload = (overrides = {}) => ({
  name: 'Victim Owner',
  email: 'victim@cafe.co.za',
  password: 'victim-password-1',
  cafeName: 'Victim Cafe',
  orgName: 'Victim Org',
  ...overrides,
});

// Every verification token handed to the mailer, in send order.
const captureVerificationTokens = () => {
  const tokens = [];
  jest.spyOn(emailService, 'sendVerificationEmail').mockImplementation(async ({ verificationToken }) => {
    tokens.push(verificationToken);
    return { sent: true };
  });
  return tokens;
};

const register = (overrides) => request.post('/api/auth/register').send(payload(overrides));
const verify = (token, password) => request.post('/api/auth/verify-email').send({ token, password });
const login = (email, password) => request.post('/api/auth/login').send({ email, password });

describe('a pending registration cannot be hijacked', () => {
  it('lets a second register replace the password, name and token of a pending signup', async () => {
    const tokens = captureVerificationTokens();
    const attacker = await register({ name: 'Attacker Name', password: 'attacker-password-1', cafeName: 'Attacker Cafe' });
    const victim = await register();

    expect(attacker.status).toBe(202);
    expect(victim.status).toBe(202);
    expect(victim.body.code).toBeUndefined();
    expect(tokens).toHaveLength(2);
    const pending = await PendingRegistration.findOne({ email: 'victim@cafe.co.za' }).lean();
    expect(pending).toEqual(expect.objectContaining({ name: 'Victim Owner', cafeName: 'Victim Cafe', resendCount: 0 }));

    expect((await verify(tokens[0], 'attacker-password-1')).status).toBe(404);
    expect((await verify(tokens[1], 'victim-password-1')).status).toBe(201);
    expect((await login('victim@cafe.co.za', 'victim-password-1')).status).toBe(200);
    expect((await login('victim@cafe.co.za', 'attacker-password-1')).status).toBe(401);
  });

  it('never completes a registration with a password the verifier does not know', async () => {
    const tokens = captureVerificationTokens();
    await register();
    // The attacker registers after the victim, so the only live link belongs to the attacker's submission.
    await register({ password: 'attacker-password-1' });

    const guess = await verify(tokens[1], 'victim-password-1');
    expect(guess.status).toBe(401);
    expect(guess.body).toEqual(expect.objectContaining({ code: 'VERIFICATION_PASSWORD_MISMATCH', attemptsRemaining: 4 }));
    expect(await User.countDocuments({ email: 'victim@cafe.co.za' })).toBe(0);
    expect(await PendingRegistration.countDocuments({ email: 'victim@cafe.co.za' })).toBe(1);
  });

  it('kills the link after five wrong passwords', async () => {
    const tokens = captureVerificationTokens();
    await register();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const wrong = await verify(tokens[0], `wrong-password-${attempt}`);
      expect(wrong.status).toBe(401);
      expect(wrong.body.attemptsRemaining).toBe(5 - attempt);
    }
    expect((await verify(tokens[0], 'wrong-password-5')).status).toBe(404);
    expect((await verify(tokens[0], 'victim-password-1')).status).toBe(404);
  });

  it('requires the password at verification and answers 400, never 500, for a non-string one', async () => {
    const tokens = captureVerificationTokens();
    await register();
    const missing = await request.post('/api/auth/verify-email').send({ token: tokens[0] });
    const numeric = await verify(tokens[0], 12345678);
    const operator = await verify(tokens[0], { $gt: '' });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('PASSWORD_REQUIRED');
    expect(numeric.status).toBe(400);
    expect(operator.status).toBe(400);
  });

  it('survives two simultaneous registrations for one address with exactly one pending record', async () => {
    captureVerificationTokens();
    const [first, second] = await Promise.all([register(), register({ password: 'other-password-1' })]);
    expect([first.status, second.status]).toEqual([202, 202]);
    expect(await PendingRegistration.countDocuments({ email: 'victim@cafe.co.za' })).toBe(1);
  });
});

describe('an invitation from another org never blocks or deletes a public signup', () => {
  it('registers, keeps the signup through invite delivery, verifies, and expires the invitation', async () => {
    const squatter = await createTestUser({ email: 'squatter@yourguava.com' });
    jest.spyOn(emailService, 'sendTeamInviteEmail').mockResolvedValue({ sent: true });
    const invite = await request.post('/api/team/invite')
      .set('Authorization', `Bearer ${squatter.token}`)
      .send({ name: 'Target Person', email: 'victim@cafe.co.za', cafeIds: [squatter.user.activeCafeId] });
    expect(invite.status).toBe(201);

    const tokens = captureVerificationTokens();
    expect((await register()).status).toBe(202);

    // A delivered resend must not delete the pending signup either.
    const resend = await request.post(`/api/team/invitations/${invite.body.invitation.id}/resend`)
      .set('Authorization', `Bearer ${squatter.token}`);
    expect(resend.status).toBe(200);
    expect(await PendingRegistration.countDocuments({ email: 'victim@cafe.co.za' })).toBe(1);

    expect((await verify(tokens[0], 'victim-password-1')).status).toBe(201);
    const invitation = await TeamInvitation.findById(invite.body.invitation.id).lean();
    expect(invitation.status).toBe('expired');
    const victim = await User.findOne({ email: 'victim@cafe.co.za' }).lean();
    expect(String(victim.orgId)).not.toBe(String(squatter.user.orgId));
    expect(victim.role).toBe('owner');
  });
});

describe('resend is capped', () => {
  it('rotates the link at most five times per registration', async () => {
    const tokens = captureVerificationTokens();
    await register();
    for (let i = 0; i < 7; i += 1) {
      const res = await request.post('/api/auth/resend-verification').send({ email: 'victim@cafe.co.za' });
      expect(res.status).toBe(200);
    }
    await settleAfterResponse();
    // One email from register plus five resends; the sixth and seventh change nothing and send nothing.
    expect(tokens).toHaveLength(6);
    const pending = await PendingRegistration.findOne({ email: 'victim@cafe.co.za' }).lean();
    expect(pending.resendCount).toBe(5);
    expect((await verify(tokens[5], 'victim-password-1')).status).toBe(201);
  });

  it('starts a fresh allowance when the owner registers again', async () => {
    const tokens = captureVerificationTokens();
    await register();
    await PendingRegistration.updateOne({ email: 'victim@cafe.co.za' }, { $set: { resendCount: 5 } });
    await register();
    await request.post('/api/auth/resend-verification').send({ email: 'victim@cafe.co.za' });
    await settleAfterResponse();
    expect(tokens).toHaveLength(3);
  });
});
