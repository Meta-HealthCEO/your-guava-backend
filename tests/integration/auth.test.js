const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const emailService = require('../../src/services/email.service');
const User = require('../../src/models/User.model');
const Cafe = require('../../src/models/Cafe.model');
const Organization = require('../../src/models/Organization.model');
const PendingRegistration = require('../../src/models/PendingRegistration.model');
const PasswordResetToken = require('../../src/models/PasswordResetToken.model');
const AuthSession = require('../../src/models/AuthSession.model');
const AccessAuditEvent = require('../../src/models/AccessAuditEvent.model');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

const registrationPayload = (overrides = {}) => ({
  name: 'Test Owner',
  email: 'test@yourguava.com',
  password: 'password123',
  cafeName: 'Test Cafe',
  orgName: 'Test Org',
  ...overrides,
});

const submitRegistration = async (overrides = {}) => {
  let verificationToken;
  const verificationSpy = jest
    .spyOn(emailService, 'sendVerificationEmail')
    .mockImplementation(async ({ verificationToken: token }) => {
      verificationToken = token;
      return { sent: true };
    });
  const response = await request
    .post('/api/auth/register')
    .send(registrationPayload(overrides));
  return { response, verificationToken, verificationSpy };
};

describe('Auth API', () => {
  describe('email-verified owner registration', () => {
    it('declares TTL cleanup for every sensitive temporary auth record', () => {
      for (const model of [PendingRegistration, PasswordResetToken, AuthSession]) {
        expect(model.schema.indexes()).toEqual(expect.arrayContaining([
          [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
        ]));
      }
    });

    it('keeps credentials pending until the single-use verification link is consumed', async () => {
      const welcomeSpy = jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockResolvedValue({ sent: true });
      const { response, verificationToken } = await submitRegistration();

      expect(response.status).toBe(202);
      expect(response.body).toEqual(expect.objectContaining({
        success: true,
        verificationRequired: true,
        email: 'test@yourguava.com',
      }));
      expect(response.body.accessToken).toBeUndefined();
      expect(response.body.user).toBeUndefined();
      expect(JSON.stringify(response.body)).not.toContain(verificationToken);
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await User.countDocuments()).toBe(0);
      expect(await Organization.countDocuments()).toBe(0);
      expect(await Cafe.countDocuments()).toBe(0);

      const pending = await PendingRegistration.findOne({
        email: 'test@yourguava.com',
      }).select('+passwordHash +tokenHash');
      expect(pending.passwordHash).toMatch(/^\$2[aby]\$/);
      expect(pending.passwordHash).not.toBe('password123');
      expect(pending.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(pending.tokenHash).not.toBe(verificationToken);

      const verified = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken });
      expect(verified.status).toBe(201);
      expect(verified.headers['cache-control']).toBe('no-store');
      expect(verified.body.accessToken).toBeUndefined();
      expect(await PendingRegistration.countDocuments()).toBe(0);

      const user = await User.findOne({ email: 'test@yourguava.com' }).lean();
      const org = await Organization.findById(user.orgId).lean();
      const cafe = await Cafe.findById(user.activeCafeId).lean();
      expect(user).toEqual(expect.objectContaining({
        name: 'Test Owner',
        role: 'owner',
        emailVerified: true,
      }));
      expect(org.name).toBe('Test Org');
      expect(String(org.ownerId)).toBe(String(user._id));
      expect(cafe.name).toBe('Test Cafe');
      expect(welcomeSpy).toHaveBeenCalledWith({
        user: expect.objectContaining({ email: 'test@yourguava.com' }),
        org: expect.objectContaining({ name: 'Test Org' }),
        cafe: expect.objectContaining({ name: 'Test Cafe' }),
      });

      const replay = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken });
      expect(replay.status).toBe(404);

      const login = await request.post('/api/auth/login').send({
        email: 'test@yourguava.com',
        password: 'password123',
      });
      expect(login.status).toBe(200);
      expect(login.body.accessToken).toBeDefined();
      expect(login.body.user.permissions).toEqual({ canSpendCredits: true });
    });

    it('does not let a second signup replace the password of a pending registration', async () => {
      const first = await submitRegistration({
        email: 'pending@yourguava.com',
        password: 'original-password',
      });
      first.verificationSpy.mockRestore();

      const second = await request.post('/api/auth/register').send(
        registrationPayload({
          email: 'pending@yourguava.com',
          password: 'attacker-password',
        })
      );
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('REGISTRATION_PENDING');

      await request
        .post('/api/auth/verify-email')
        .send({ token: first.verificationToken });
      const originalLogin = await request.post('/api/auth/login').send({
        email: 'pending@yourguava.com',
        password: 'original-password',
      });
      const attackerLogin = await request.post('/api/auth/login').send({
        email: 'pending@yourguava.com',
        password: 'attacker-password',
      });
      expect(originalLogin.status).toBe(200);
      expect(attackerLogin.status).toBe(401);
    });

    it('retains the pending registration when verification delivery fails', async () => {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      jest.spyOn(emailService, 'sendVerificationEmail').mockResolvedValue({
        skipped: true,
        reason: 'resend_not_configured',
      });
      const response = await request
        .post('/api/auth/register')
        .send(registrationPayload({ email: 'delivery@yourguava.com' }));

      expect(response.status).toBe(503);
      expect(response.body.code).toBe('VERIFICATION_EMAIL_FAILED');
      expect(await PendingRegistration.countDocuments({
        email: 'delivery@yourguava.com',
      })).toBe(1);
      expect(await User.countDocuments({ email: 'delivery@yourguava.com' })).toBe(0);
      expect(errorSpy).toHaveBeenCalled();
    });

    it('rotates verification links on resend without revealing account existence', async () => {
      const initial = await submitRegistration({ email: 'resend@yourguava.com' });
      initial.verificationSpy.mockRestore();

      let replacementToken;
      jest
        .spyOn(emailService, 'sendVerificationEmail')
        .mockImplementation(async ({ verificationToken }) => {
          replacementToken = verificationToken;
          return { sent: true };
        });
      const resent = await request
        .post('/api/auth/resend-verification')
        .send({ email: 'resend@yourguava.com' });
      const unknown = await request
        .post('/api/auth/resend-verification')
        .send({ email: 'unknown@yourguava.com' });
      expect(resent.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(unknown.body.message).toBe(resent.body.message);
      expect(JSON.stringify(resent.body)).not.toContain(replacementToken);

      const stale = await request
        .post('/api/auth/verify-email')
        .send({ token: initial.verificationToken });
      expect(stale.status).toBe(404);
      const accepted = await request
        .post('/api/auth/verify-email')
        .send({ token: replacementToken });
      expect(accepted.status).toBe(201);
    });

    it('still completes verification when the non-critical welcome email fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockRejectedValue(new Error('resend unavailable'));
      const { verificationToken } = await submitRegistration({
        email: 'welcome-failure@yourguava.com',
      });
      const verified = await request
        .post('/api/auth/verify-email')
        .send({ token: verificationToken });
      expect(verified.status).toBe(201);
      expect(warnSpy).toHaveBeenCalledWith(
        '[auth] Welcome email failed after verification:',
        'resend unavailable'
      );
    });

    it('validates required fields, password length, and tenant names', async () => {
      const missing = await request
        .post('/api/auth/register')
        .send({ email: 'missing@yourguava.com' });
      expect(missing.status).toBe(400);

      const short = await request.post('/api/auth/register').send(
        registrationPayload({
          email: 'short@yourguava.com',
          password: 'short7',
        })
      );
      expect(short.status).toBe(400);
      expect(short.body.message).toMatch(/at least 8/i);

      const oversized = await request.post('/api/auth/register').send(
        registrationPayload({
          email: 'oversized@yourguava.com',
          cafeName: 'x'.repeat(121),
        })
      );
      expect(oversized.status).toBe(400);
      expect(oversized.body.message).toMatch(/cafe name/i);
    });
  });

  describe('login, profile, and logout', () => {
    it('logs in with valid credentials and rejects invalid credentials', async () => {
      await createTestUser({
        name: 'Login User',
        email: 'login@yourguava.com',
        cafeName: 'Login Cafe',
      });
      const valid = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'password123',
      });
      const wrong = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'wrongpassword',
      });
      const missing = await request.post('/api/auth/login').send({
        email: 'doesnotexist@yourguava.com',
        password: 'password123',
      });
      expect(valid.status).toBe(200);
      expect(valid.body.accessToken).toBeDefined();
      expect(wrong.status).toBe(401);
      expect(missing.status).toBe(401);
    });

    it('returns the live profile for a valid token', async () => {
      const testUser = await createTestUser({
        name: 'Me User',
        email: 'me@yourguava.com',
      });
      const response = await request
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${testUser.token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining({
        email: 'me@yourguava.com',
        name: 'Me User',
        emailVerified: true,
        permissions: { canSpendCredits: true },
      }));
      expect((await request.get('/api/auth/me')).status).toBe(401);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', 'Bearer invalid-token-here')
        ).status
      ).toBe(401);
    });

    it('revokes the refresh family on cookie-only logout', async () => {
      const testUser = await createTestUser({ email: 'logout@yourguava.com' });
      const response = await request
        .post('/api/auth/logout')
        .set('Cookie', testUser.cookie);
      expect(response.status).toBe(200);
      expect(String(response.headers['set-cookie'])).toContain('refreshToken=');
      const replay = await request
        .post('/api/auth/refresh')
        .set('Cookie', testUser.cookie);
      expect(replay.status).toBe(401);
    });
  });

  describe('password recovery and changes', () => {
    it('uses a generic forgot-password response and a single-use reset token', async () => {
      const testUser = await createTestUser({ email: 'reset@yourguava.com' });
      let resetToken;
      jest
        .spyOn(emailService, 'sendPasswordResetEmail')
        .mockImplementation(async ({ resetToken: token }) => {
          resetToken = token;
          return { sent: true };
        });

      const known = await request
        .post('/api/auth/forgot-password')
        .send({ email: 'reset@yourguava.com' });
      const unknown = await request
        .post('/api/auth/forgot-password')
        .send({ email: 'unknown@yourguava.com' });
      expect(known.status).toBe(200);
      expect(known.body.message).toBe(unknown.body.message);
      expect(JSON.stringify(known.body)).not.toContain(resetToken);

      const stored = await PasswordResetToken.findOne({
        userId: testUser.user.id,
      }).select('+tokenHash');
      expect(stored.tokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(stored.tokenHash).not.toBe(resetToken);

      const reset = await request.post('/api/auth/reset-password').send({
        token: resetToken,
        password: 'newpassword456',
      });
      expect(reset.status).toBe(200);
      expect(reset.headers['cache-control']).toBe('no-store');

      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'reset@yourguava.com',
            password: 'password123',
          })
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'reset@yourguava.com',
            password: 'newpassword456',
          })
        ).status
      ).toBe(200);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${testUser.token}`)
        ).status
      ).toBe(401);
      expect(
        (
          await request
            .post('/api/auth/refresh')
            .set('Cookie', testUser.cookie)
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/reset-password').send({
            token: resetToken,
            password: 'another-password-789',
          })
        ).status
      ).toBe(404);
      expect(await AccessAuditEvent.countDocuments({
        action: 'password.reset',
        targetEmail: 'reset@yourguava.com',
      })).toBe(1);
    });

    it('changes a password, revokes existing sessions, and rejects wrong or reused passwords', async () => {
      const testUser = await createTestUser({
        email: 'change@yourguava.com',
      });
      const wrong = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'not-the-password',
          newPassword: 'newpassword456',
        });
      expect(wrong.status).toBe(401);

      const reused = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'password123',
        });
      expect(reused.status).toBe(400);

      const changed = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${testUser.token}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'newpassword456',
        });
      expect(changed.status).toBe(200);
      expect(changed.body.message).toMatch(/sign in again/i);
      expect(
        (
          await request
            .get('/api/auth/me')
            .set('Authorization', `Bearer ${testUser.token}`)
        ).status
      ).toBe(401);
      expect(
        (
          await request
            .post('/api/auth/refresh')
            .set('Cookie', testUser.cookie)
        ).status
      ).toBe(401);
      expect(
        (
          await request.post('/api/auth/login').send({
            email: 'change@yourguava.com',
            password: 'newpassword456',
          })
        ).status
      ).toBe(200);
      expect(await AccessAuditEvent.countDocuments({
        action: 'password.changed',
      })).toBe(1);
    });
  });
});
