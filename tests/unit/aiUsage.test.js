jest.mock('../../src/services/usage.service', () => ({
  consumeGuavaCredits: jest.fn(async () => ({ remaining: 97 })),
  creditSnapshot: jest.fn(),
  ensureFreshCreditWindow: jest.fn(),
  meterGuavaCredits: jest.fn(),
}));

const { consumeAiCredits } = require('../../src/services/aiUsage.service');
const { consumeGuavaCredits } = require('../../src/services/usage.service');

describe('Ask Guava credit consumption helper', () => {
  beforeEach(() => {
    consumeGuavaCredits.mockClear();
  });

  it('refuses to charge without an idempotency key', async () => {
    // The signature invites a bare "just charge N credits" call, and without a
    // key every client retry would be a fresh charge for the same answer.
    await expect(consumeAiCredits('org-1', 3)).rejects.toMatchObject({
      statusCode: 400,
      code: 'USAGE_IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(consumeGuavaCredits).not.toHaveBeenCalled();
  });

  it('forwards a keyed charge to the metering service', async () => {
    await consumeAiCredits('org-1', 3, { idempotencyKey: 'answer-42' });

    expect(consumeGuavaCredits).toHaveBeenCalledWith('org-1', 3, expect.objectContaining({
      featureKey: 'ask_guava_chat',
      provider: 'anthropic',
      idempotencyKey: 'answer-42',
    }));
  });
});
