const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');
const emailService = require('../../src/services/email.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  jest.restoreAllMocks();
  await clearDB();
});

describe('Auth API', () => {
  describe('POST /api/auth/register', () => {
    it('creates user, org, and cafe, returns token', async () => {
      const welcomeSpy = jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockResolvedValue({ sent: true });

      const res = await request.post('/api/auth/register').send({
        name: 'Test Owner',
        email: 'test@yourguava.com',
        password: 'password123',
        cafeName: 'Test Cafe',
        orgName: 'Test Org',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe('test@yourguava.com');
      expect(res.body.user.name).toBe('Test Owner');
      expect(res.body.user.role).toBe('owner');
      expect(res.body.user.orgId).toBeDefined();
      expect(res.body.user.activeCafeId).toBeDefined();
      expect(welcomeSpy).toHaveBeenCalledTimes(1);
      expect(welcomeSpy).toHaveBeenCalledWith({
        user: expect.objectContaining({
          email: 'test@yourguava.com',
          name: 'Test Owner',
        }),
        org: expect.objectContaining({ name: 'Test Org' }),
        cafe: expect.objectContaining({ name: 'Test Cafe' }),
      });
    });

    it('still creates the account when the welcome email fails', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const welcomeSpy = jest
        .spyOn(emailService, 'sendWelcomeEmail')
        .mockRejectedValue(new Error('resend unavailable'));

      const res = await request.post('/api/auth/register').send({
        name: 'Email Resilient Owner',
        email: 'resilient@yourguava.com',
        password: 'password123',
        cafeName: 'Resilient Cafe',
        orgName: 'Resilient Org',
      });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user.email).toBe('resilient@yourguava.com');
      expect(welcomeSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        '[auth] Welcome email failed after registration:',
        'resend unavailable'
      );
    });

    it('returns 409 for duplicate email', async () => {
      await request.post('/api/auth/register').send({
        name: 'User One',
        email: 'dupe@yourguava.com',
        password: 'password123',
        cafeName: 'Cafe 1',
      });

      const res = await request.post('/api/auth/register').send({
        name: 'User Two',
        email: 'dupe@yourguava.com',
        password: 'password456',
        cafeName: 'Cafe 2',
      });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/already registered/i);
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request.post('/api/auth/register').send({
        email: 'test@yourguava.com',
        // missing password and name
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when password is shorter than 8 characters', async () => {
      const res = await request.post('/api/auth/register').send({
        name: 'Short Password',
        email: 'short@yourguava.com',
        password: 'short7',
        cafeName: 'Short Cafe',
      });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/at least 8/i);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeEach(async () => {
      await request.post('/api/auth/register').send({
        name: 'Login User',
        email: 'login@yourguava.com',
        password: 'password123',
        cafeName: 'Login Cafe',
      });
    });

    it('returns token for valid credentials', async () => {
      const res = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'password123',
      });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user.email).toBe('login@yourguava.com');
    });

    it('returns 401 for wrong password', async () => {
      const res = await request.post('/api/auth/login').send({
        email: 'login@yourguava.com',
        password: 'wrongpassword',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid credentials/i);
    });

    it('returns 401 for non-existent email', async () => {
      const res = await request.post('/api/auth/login').send({
        email: 'doesnotexist@yourguava.com',
        password: 'password123',
      });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns user profile with valid token', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Me User',
        email: 'me@yourguava.com',
        password: 'password123',
        cafeName: 'My Cafe',
      });

      const token = regRes.body.accessToken;

      const res = await request
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('me@yourguava.com');
      expect(res.body.name).toBe('Me User');
    });

    it('returns 401 without token', async () => {
      const res = await request.get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 with invalid token', async () => {
      const res = await request
        .get('/api/auth/me')
        .set('Authorization', 'Bearer invalid-token-here');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('clears session and returns success', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Logout User',
        email: 'logout@yourguava.com',
        password: 'password123',
        cafeName: 'Logout Cafe',
      });

      const token = regRes.body.accessToken;

      const res = await request
        .post('/api/auth/logout')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/logged out/i);
    });

    it('clears the refresh session even when the access token is missing', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Cookie Logout User',
        email: 'cookie-logout@yourguava.com',
        password: 'password123',
        cafeName: 'Cookie Logout Cafe',
      });

      const res = await request
        .post('/api/auth/logout')
        .set('Cookie', regRes.headers['set-cookie']);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(String(res.headers['set-cookie'])).toContain('refreshToken=');

      const refreshReplay = await request
        .post('/api/auth/refresh')
        .set('Cookie', regRes.headers['set-cookie']);
      expect(refreshReplay.status).toBe(401);
    });
  });

  describe('POST /api/auth/change-password', () => {
    it('changes the password, clears refresh tokens, and requires the new password', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Password User',
        email: 'password-change@yourguava.com',
        password: 'password123',
        cafeName: 'Password Cafe',
      });

      const res = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${regRes.body.accessToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'newpassword456',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toMatch(/sign in again/i);
      expect(String(res.headers['set-cookie'])).toContain('refreshToken=');

      const staleAccess = await request
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${regRes.body.accessToken}`);
      expect(staleAccess.status).toBe(401);
      expect(staleAccess.body.message).toMatch(/sign in again|invalid or expired token/i);

      const oldLogin = await request.post('/api/auth/login').send({
        email: 'password-change@yourguava.com',
        password: 'password123',
      });
      expect(oldLogin.status).toBe(401);

      const newLogin = await request.post('/api/auth/login').send({
        email: 'password-change@yourguava.com',
        password: 'newpassword456',
      });
      expect(newLogin.status).toBe(200);

      const freshAccess = await request
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${newLogin.body.accessToken}`);
      expect(freshAccess.status).toBe(200);
      expect(freshAccess.body.email).toBe('password-change@yourguava.com');

      const refreshReplay = await request
        .post('/api/auth/refresh')
        .set('Cookie', regRes.headers['set-cookie']);
      expect(refreshReplay.status).toBe(401);
    });

    it('rejects an incorrect current password without changing it', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Wrong Current',
        email: 'wrong-current@yourguava.com',
        password: 'password123',
        cafeName: 'Wrong Cafe',
      });

      const res = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${regRes.body.accessToken}`)
        .send({
          currentPassword: 'not-the-password',
          newPassword: 'newpassword456',
        });

      expect(res.status).toBe(401);
      expect(res.body.message).toMatch(/incorrect/i);

      const oldLogin = await request.post('/api/auth/login').send({
        email: 'wrong-current@yourguava.com',
        password: 'password123',
      });
      expect(oldLogin.status).toBe(200);
    });

    it('rejects short and reused new passwords', async () => {
      const regRes = await request.post('/api/auth/register').send({
        name: 'Validation User',
        email: 'password-validation@yourguava.com',
        password: 'password123',
        cafeName: 'Validation Cafe',
      });

      const shortRes = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${regRes.body.accessToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'short7',
        });
      expect(shortRes.status).toBe(400);
      expect(shortRes.body.message).toMatch(/at least 8/i);

      const reusedRes = await request
        .post('/api/auth/change-password')
        .set('Authorization', `Bearer ${regRes.body.accessToken}`)
        .send({
          currentPassword: 'password123',
          newPassword: 'password123',
        });
      expect(reusedRes.status).toBe(400);
      expect(reusedRes.body.message).toMatch(/different/i);
    });
  });
});
