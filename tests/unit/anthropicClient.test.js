const { getAnthropicClientOptions } = require('../../src/services/anthropicClient.service');

describe('Anthropic client bounds', () => {
  const originalTimeout = process.env.ANTHROPIC_TIMEOUT_MS;
  const originalRetries = process.env.ANTHROPIC_MAX_RETRIES;

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.ANTHROPIC_TIMEOUT_MS;
    else process.env.ANTHROPIC_TIMEOUT_MS = originalTimeout;
    if (originalRetries === undefined) delete process.env.ANTHROPIC_MAX_RETRIES;
    else process.env.ANTHROPIC_MAX_RETRIES = originalRetries;
  });

  it('uses bounded production defaults', () => {
    delete process.env.ANTHROPIC_TIMEOUT_MS;
    delete process.env.ANTHROPIC_MAX_RETRIES;
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 30_000, maxRetries: 1 })
    );
  });

  it('clamps unsafe timeout and retry values', () => {
    process.env.ANTHROPIC_TIMEOUT_MS = '999999';
    process.env.ANTHROPIC_MAX_RETRIES = '99';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 60_000, maxRetries: 2 })
    );

    process.env.ANTHROPIC_TIMEOUT_MS = '1';
    process.env.ANTHROPIC_MAX_RETRIES = '-5';
    expect(getAnthropicClientOptions()).toEqual(
      expect.objectContaining({ timeout: 5_000, maxRetries: 0 })
    );
  });
});
