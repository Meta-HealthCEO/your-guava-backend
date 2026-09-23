process.env.RATE_LIMITS_ENABLED = 'true';
process.env.CLIENT_URL = 'http://localhost:5185';
const supertest = require('supertest');
const { setup, teardown, app } = require('../setup');
const { getLimiterOptions } = require('../../src/middleware/rateLimit.middleware');

const request = supertest(app);
beforeAll(setup);
afterAll(teardown);

describe('login limiter with limits on, as in production', () => {
  it('answers the attempt after the per-IP budget with 429, and the 429 still carries CORS headers', async () => {
    const { limit } = getLimiterOptions('login');
    const attempt = (index) => request
      .post('/api/auth/login')
      .set('Origin', 'http://localhost:5185')
      .send({ email: `nobody-${index}@yourguava.com`, password: 'wrong-password' });

    for (let index = 0; index < limit; index += 1) {
      const res = await attempt(index);
      expect(res.status).not.toBe(429);
    }
    const limited = await attempt(limit);

    expect(limit).toBe(20);
    expect(limited.status).toBe(429);
    expect(limited.headers['access-control-allow-origin']).toBe('http://localhost:5185');
    expect(limited.headers['ratelimit-policy']).toBeDefined();
    expect(limited.body).toEqual(expect.objectContaining({ success: false, code: 'AUTH_RATE_LIMITED' }));
  });
});
