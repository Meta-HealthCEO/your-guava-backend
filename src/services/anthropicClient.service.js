const Anthropic = require('@anthropic-ai/sdk');

const clampInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const getAnthropicClientOptions = () => ({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: clampInteger(process.env.ANTHROPIC_TIMEOUT_MS, 30_000, 5_000, 60_000),
  maxRetries: clampInteger(process.env.ANTHROPIC_MAX_RETRIES, 1, 0, 2),
});

const createAnthropicClient = () => new Anthropic(getAnthropicClientOptions());

module.exports = {
  createAnthropicClient,
  getAnthropicClientOptions,
};
