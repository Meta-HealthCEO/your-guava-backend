const express = require('express');
const supertest = require('supertest');
const { createAuthLimiters, authLimiters, AUTH_LIMITS } = require('../../src/middleware/rateLimit.middleware');
const authRoutes = require('../../src/routes/auth.routes');

const chainFor = (method, path) => {
  const layer = authRoutes.stack.find((entry) => entry.route && entry.route.path === path && entry.route.methods[method]);
  return layer.route.stack.map((entry) => entry.handle);
};

describe('auth limiters', () => {
  it('gives login, register and password reset separate buckets', async () => {
    const limiters = createAuthLimiters({
      skip: () => false,
      limits: { login: { limit: 2 }, register: { limit: 2 }, passwordReset: { limit: 2 } },
    });
    const app = express();
    const ok = (req, res) => res.status(204).end();
    app.post('/login', limiters.login, ok);
    app.post('/register', limiters.register, ok);
    app.post('/forgot', limiters.passwordReset, ok);
    const request = supertest(app);
    expect((await request.post('/login')).status).toBe(204);
    expect((await request.post('/login')).status).toBe(204);
    const third = await request.post('/login');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('AUTH_RATE_LIMITED');
    expect((await request.post('/register')).status).toBe(204);
    expect((await request.post('/forgot')).status).toBe(204);
  });

  it('mounts one limiter per action on the auth router', () => {
    expect(chainFor('post', '/login')).toContain(authLimiters.login);
    expect(chainFor('post', '/login')).not.toContain(authLimiters.register);
    expect(chainFor('post', '/register')).toContain(authLimiters.register);
    expect(chainFor('post', '/forgot-password')).toContain(authLimiters.passwordReset);
    expect(chainFor('post', '/reset-password')).toContain(authLimiters.passwordReset);
    expect(chainFor('post', '/verify-email')).toContain(authLimiters.verification);
    expect(chainFor('post', '/resend-verification')).toContain(authLimiters.verification);
    expect(chainFor('post', '/change-password')).toContain(authLimiters.changePassword);
    expect(new Set(Object.values(authLimiters)).size).toBe(5);
    expect(AUTH_LIMITS.login).toEqual({ windowMs: 15 * 60 * 1000, limit: 20 });
  });
});
