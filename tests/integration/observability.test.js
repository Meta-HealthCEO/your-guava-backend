const supertest = require('supertest');
const { setup, teardown, clearDB, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Observability', () => {
  it('echoes a trusted request ID on health responses', async () => {
    const requestId = 'launch-smoke-req-001';

    const res = await request
      .get('/api/health')
      .set('X-Request-Id', requestId);

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe(requestId);
    expect(res.body).toEqual(
      expect.objectContaining({
        success: true,
        status: 'ok',
        service: 'your-guava-api',
        requestId,
      })
    );
  });

  it('reports readiness with database and env checks', async () => {
    const res = await request.get('/api/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.database).toEqual(
      expect.objectContaining({ ok: true, state: 'connected' })
    );
    expect(res.body.checks.environment).toEqual(
      expect.objectContaining({ ok: true })
    );
  });

  it('returns JSON 404 responses with request IDs for unknown API routes', async () => {
    const requestId = 'unknown-route-req-001';

    const res = await request
      .get('/api/not-a-real-route')
      .set('X-Request-Id', requestId);

    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe(requestId);
    expect(res.body).toEqual({
      success: false,
      message: 'Route not found',
      requestId,
    });
  });
});
