const mockAnthropicMessageCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: mockAnthropicMessageCreate },
})));

const supertest = require('supertest');
const {
  setup,
  teardown,
  clearDB,
  createTestUser,
  app,
} = require('../setup');
const Organization = require('../../src/models/Organization.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  _resetInsightsCache();
  delete process.env.ANTHROPIC_API_KEY;
  await clearDB();
});

describe('explicit insight refresh', () => {
  it('keeps GET read-only and coalesces/replays metered refreshes', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await UsageLedger.init();
    mockAnthropicMessageCreate.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { content: [{ type: 'text', text: '["Prepare more flat whites tomorrow."]' }] };
    });

    const initialRead = await request
      .get('/api/forecasts/insights')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(initialRead.status).toBe(200);
    expect(initialRead.body).toEqual(expect.objectContaining({
      insights: [],
      generatedAt: null,
      requiresRefresh: true,
      cacheStatus: 'empty',
    }));
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);

    const refreshRequest = () => request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'stable-insight-refresh')
      .send({});
    const [first, second] = await Promise.all([refreshRequest(), refreshRequest()]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.insights).toEqual(['Prepare more flat whites tomorrow.']);
    expect(second.body.insights).toEqual(first.body.insights);
    expect([first.body.meta.coalesced, second.body.meta.coalesced].sort()).toEqual([false, true]);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const retry = await refreshRequest();
    expect(retry.status).toBe(200);
    expect(retry.body.meta.replayed).toBe(true);
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const cachedRead = await request
      .get('/api/forecasts/insights')
      .set('Authorization', `Bearer ${owner.token}`);
    expect(cachedRead.body).toEqual(expect.objectContaining({
      insights: ['Prepare more flat whites tomorrow.'],
      requiresRefresh: false,
      cacheStatus: 'fresh',
    }));
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(10);
    expect(await UsageLedger.countDocuments({
      featureKey: 'insight_refresh',
      status: 'committed',
    })).toBe(1);
  });
});
