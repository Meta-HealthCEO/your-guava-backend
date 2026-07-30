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
const GeneratedInsight = require('../../src/models/GeneratedInsight.model');
const InsightChat = require('../../src/models/InsightChat.model');
const UsageLedger = require('../../src/models/UsageLedger.model');
const { _resetInsightsCache } = require('../../src/services/anthropic.service');

const request = supertest(app);

beforeAll(setup);
afterAll(teardown);
afterEach(async () => {
  mockAnthropicMessageCreate.mockReset();
  await _resetInsightsCache();
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

  it('requires an idempotency key before starting a paid refresh', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/Idempotency-Key is required/i);
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
    expect(await UsageLedger.countDocuments({})).toBe(0);
  });

  it('does not turn a metering conflict and empty cache stub into a successful refresh', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await Promise.all([GeneratedInsight.init(), UsageLedger.init()]);
    await GeneratedInsight.create({
      cafeId: owner.user.activeCafeId,
      orgId: owner.user.orgId,
      insights: [],
      generatedAt: null,
    });
    await UsageLedger.create({
      orgId: owner.user.orgId,
      cafeId: owner.user.activeCafeId,
      userId: owner.user._id,
      featureKey: 'ask_guava_chat',
      label: 'Ask Guava answer',
      credits: 3,
      status: 'reserved',
      idempotencyKey: 'conflicting-insight-refresh',
      requestFingerprint: '0'.repeat(64),
      reservedAt: new Date(),
    });

    const response = await request
      .post('/api/forecasts/insights/refresh')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'conflicting-insight-refresh')
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.success).toBe(false);
    expect(response.body.details?.code).toBe('USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT');
    expect(mockAnthropicMessageCreate).not.toHaveBeenCalled();
  });

  it('durably stores a paid chat answer and replays it without a second charge', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    const owner = await createTestUser();
    await UsageLedger.init();
    mockAnthropicMessageCreate.mockResolvedValue({
      id: 'provider-chat-request',
      model: 'test-model',
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Flat whites led sales this week.' }],
    });

    const created = await request
      .post('/api/insight-chats')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        title: 'Best sellers',
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
        ],
      });
    const chatId = created.body.chat._id;
    const chatRequest = () => request
      .post('/api/forecasts/insights/chat')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'durable-chat-answer')
      .send({
        chatId,
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
        ],
      });

    const first = await chatRequest();
    const clientSave = await request
      .patch(`/api/insight-chats/${chatId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
          { role: 'assistant', content: 'Flat whites led sales this week.' },
        ],
        contextStats: first.body.contextStats,
      });
    const replay = await chatRequest();
    const streamReplay = await request
      .post('/api/forecasts/insights/chat/stream')
      .set('Authorization', `Bearer ${owner.token}`)
      .set('Idempotency-Key', 'durable-chat-answer')
      .send({
        chatId,
        messages: [
          { role: 'user', content: 'How did yesterday go?' },
          { role: 'assistant', content: 'Yesterday was steady.' },
          { role: 'user', content: 'What sold best?' },
        ],
      });

    expect(first.status).toBe(200);
    expect(clientSave.status).toBe(200);
    expect(first.body.answer).toBe('Flat whites led sales this week.');
    expect(replay.status).toBe(200);
    expect(replay.body.meta.replayed).toBe(true);
    expect(streamReplay.status).toBe(200);
    expect(streamReplay.headers['content-type']).toMatch(/text\/event-stream/);
    expect(streamReplay.text).toContain('event: delta');
    expect(streamReplay.text).toContain('Flat whites led sales this week.');
    expect(streamReplay.text).toContain('"replayed":true');
    expect(mockAnthropicMessageCreate).toHaveBeenCalledTimes(1);

    const chat = await InsightChat.findById(chatId).lean();
    expect(chat.messages).toHaveLength(4);
    expect(chat.messages[2]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'What sold best?',
    }));
    expect(chat.messages[3]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Flat whites led sales this week.',
    }));
    const ledger = await UsageLedger.findOne({ idempotencyKey: 'durable-chat-answer' }).lean();
    expect(ledger.resultPayload).toEqual(expect.objectContaining({
      answer: 'Flat whites led sales this week.',
    }));
    expect(ledger.providerDiagnostics).toEqual(expect.objectContaining({
      providerRequestId: 'provider-chat-request',
      inputTokens: 100,
      outputTokens: 20,
    }));
    const org = await Organization.findById(owner.user.orgId).lean();
    expect(org.aiCredits.used).toBe(3);
  });
});
