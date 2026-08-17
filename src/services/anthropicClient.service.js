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

/**
 * Normalises a failure from the Anthropic SDK into something safe to return.
 *
 * Two problems with letting the SDK error through untouched:
 *   - it carries `status` (e.g. 401 for a bad key), and the error middleware
 *     resolves `err.statusCode || err.status`, so an upstream auth failure
 *     reached the browser as a 401. The portal reads any 401 as *its own*
 *     session expiring and burns a token refresh trying to recover.
 *   - its message is the provider's raw JSON body, which is meaningless to a
 *     cafe owner and exposes internal detail.
 *
 * The underlying error is still logged server-side by the error middleware.
 */
const asUpstreamAiError = (error) => {
  const wrapped = new Error(
    'The AI service is temporarily unavailable. No credits were charged — please try again shortly.'
  );
  wrapped.statusCode = 503;
  wrapped.upstreamStatus = error?.status ?? error?.statusCode ?? null;
  wrapped.cause = error;
  return wrapped;
};

/** Runs an Anthropic SDK call, converting provider failures for the client. */
const withAnthropicErrors = async (run) => {
  try {
    return await run();
  } catch (error) {
    // An abort is the caller giving up, not an upstream fault — leave it alone
    // so streaming cancellation keeps behaving as it does today.
    if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') throw error;
    throw asUpstreamAiError(error);
  }
};

module.exports = {
  createAnthropicClient,
  getAnthropicClientOptions,
  asUpstreamAiError,
  withAnthropicErrors,
};
