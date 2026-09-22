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

  it('logs the mounted request path without the query string', async () => {
    // Request logs are off under NODE_ENV=test; flip it for one request so the
    // logger runs, then read the structured line it wrote.
    const previousNodeEnv = process.env.NODE_ENV;
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    let entries;
    try {
      await request.get('/api/auth/me').query({ token: 'should-not-be-logged' });
      await new Promise((resolve) => setImmediate(resolve));
      entries = infoSpy.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry && entry.event === 'http_request');
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      infoSpy.mockRestore();
    }

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: 'GET', path: '/api/auth/me', statusCode: 401 });
    expect(JSON.stringify(entries[0])).not.toContain('should-not-be-logged');
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
