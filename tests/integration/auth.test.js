const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Auth API', () => {
  describe('POST /api/auth/register', () => {
    it('creates user, org, and cafe, returns token', async () => {
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
  });
});
