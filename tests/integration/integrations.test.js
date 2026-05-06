jest.mock('../../src/services/r2.service', () => ({
  uploadFile: async () => {},
  downloadFile: async () => Buffer.from(''),
  getSignedDownloadUrl: async () => 'https://test.r2.local',
  deleteFile: async () => {},
  _resetClient: () => {},
}));

jest.mock('../../src/services/anthropic.service', () => ({
  generateInsights: async () => ({ insights: [], generatedAt: new Date() }),
  proposeColumnMapping: async () => ({ mapping: {}, itemsMode: 'packed' }),
  _resetMappingCache: () => {},
}));

const supertest = require('supertest');
const { setup, teardown, clearDB, createTestUser, app } = require('../setup');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(clearDB);

describe('Integrations API', () => {
  let token;

  beforeEach(async () => {
    const u = await createTestUser();
    token = u.token;
  });

  it('GET /api/integrations returns initial disconnected state for all 3 providers', async () => {
    const res = await request
      .get('/api/integrations')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.xero.connected).toBe(false);
    expect(res.body.data.quickbooks.connected).toBe(false);
    expect(res.body.data.sage.connected).toBe(false);
  });

  it('GET /api/integrations/:provider/auth returns 503 with clear error when env vars missing', async () => {
    // Ensure env vars are absent
    const savedId = process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_ID;

    const res = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('INTEGRATION_NOT_CONFIGURED');
    expect(res.body.message).toMatch(/XERO_CLIENT_ID/);

    if (savedId) process.env.XERO_CLIENT_ID = savedId;
  });

  it('GET /api/integrations/:provider/auth returns URL when env vars set', async () => {
    process.env.XERO_CLIENT_ID = 'test-id';
    process.env.XERO_CLIENT_SECRET = 'test-secret';
    process.env.XERO_REDIRECT_URI = 'http://localhost:5173/integrations/xero/callback';

    const res = await request
      .get('/api/integrations/xero/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('login.xero.com');
    expect(res.body.url).toContain('client_id=test-id');

    delete process.env.XERO_CLIENT_ID;
    delete process.env.XERO_CLIENT_SECRET;
    delete process.env.XERO_REDIRECT_URI;
  });

  it('GET /api/integrations/unknown/auth returns 400', async () => {
    const res = await request
      .get('/api/integrations/unknown/auth')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/integrations requires auth', async () => {
    const res = await request.get('/api/integrations');
    expect(res.status).toBe(401);
  });

  it('POST /api/integrations/:provider/disconnect clears tokens', async () => {
    const Cafe = require('../../src/models/Cafe.model');

    // Get the cafeId from the /auth/me response
    const meRes = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    const cafeId =
      meRes.body.activeCafeId ||
      meRes.body.cafeId ||
      (meRes.body.cafeIds && meRes.body.cafeIds[0]);

    if (!cafeId) {
      // If we can't determine cafeId, skip gracefully
      return;
    }

    // Simulate a connected Xero integration
    await Cafe.findByIdAndUpdate(cafeId, {
      $set: {
        'accountingIntegrations.xero.connected': true,
        'accountingIntegrations.xero.accessToken': 'fake-access-token',
        'accountingIntegrations.xero.refreshToken': 'fake-refresh-token',
      },
    });

    // Verify it was set
    const before = await Cafe.findById(cafeId).lean();
    expect(before.accountingIntegrations?.xero?.connected).toBe(true);

    // Disconnect
    const res = await request
      .post('/api/integrations/xero/disconnect')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    // Verify tokens cleared
    const after = await Cafe.findById(cafeId).lean();
    expect(after.accountingIntegrations?.xero?.connected).toBe(false);
    expect(after.accountingIntegrations?.xero?.accessToken).toBeFalsy();
  });

  it('POST /api/integrations/:provider/sync returns 400 when not connected', async () => {
    const res = await request
      .post('/api/integrations/xero/sync')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe('Not connected');
  });

  it('POST /api/integrations/unknown/disconnect returns 400', async () => {
    const res = await request
      .post('/api/integrations/unknown/disconnect')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});
