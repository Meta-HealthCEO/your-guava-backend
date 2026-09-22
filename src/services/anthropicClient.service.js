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

const MAX_UPSTREAM_MESSAGE_CHARS = 200;

/**
 * Reduces an SDK error to `{ status, type, message }` that is safe to log.
 *
 * An `APIError.message` embeds the provider's raw response body (JSON, or an
 * HTML page from a proxy), so only the parsed body's error object is used. The
 * SDK nests the API error under `body.error`; a flat body is tolerated too.
 * When there is no parsed body, `message` is kept only for connection-level
 * errors (no HTTP status), where the SDK generates it itself.
 */
const upstreamErrorSummary = (error) => {
  const status = error?.status ?? error?.statusCode ?? null;
  const body = error?.error && typeof error.error === 'object'
    ? (error.error.error ?? error.error)
    : null;
  const type = body?.type || error?.name || null;
  const detail = body
    ? body.message
    : (status == null && error?.error === undefined ? error?.message : null);
  const message = [type, typeof detail === 'string' ? detail : null]
    .filter(Boolean)
    .join(': ');
  return {
    status,
    type,
    message: message ? message.slice(0, MAX_UPSTREAM_MESSAGE_CHARS) : null,
  };
};

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
 * `upstreamStatus` / `upstreamMessage` carry the reason for the server-side
 * log only; the error middleware never sends them to the client.
 */
const asUpstreamAiError = (error) => {
  const summary = upstreamErrorSummary(error);
  const wrapped = new Error(
    'The AI service is temporarily unavailable. No credits were charged — please try again shortly.'
  );
  wrapped.statusCode = 503;
  // The message above is written for a cafe owner and says no credits were
  // charged, which is true — meterGuavaCredits refunds a failed run. It is
  // currently discarded before it reaches them: error.middleware.js rewrites
  // every >= 500 message to "Internal Server Error" in production, so the one
  // environment that matters shows the owner nothing and they assume they were
  // billed. This flag names the contract the middleware needs to honour to skip
  // that rewrite; until it does, the friendly text is dev-only.
  wrapped.exposeMessage = true;
  wrapped.upstreamStatus = summary.status;
  wrapped.upstreamMessage = summary.message;
  wrapped.cause = error;
  return wrapped;
};

/**
 * Runs an Anthropic SDK call, converting provider failures for the client.
 * `operation` names the call in the failure log; callers that swallow the
 * wrapped error (e.g. column-mapping fallback) otherwise leave no trace of why.
 */
const withAnthropicErrors = async (run, operation = 'request') => {
  try {
    return await run();
  } catch (error) {
    // An abort is the caller giving up, not an upstream fault — leave it alone
    // so streaming cancellation keeps behaving as it does today.
    if (error?.name === 'AbortError' || error?.name === 'APIUserAbortError') throw error;
    const { status, type } = upstreamErrorSummary(error);
    console.error(`[anthropic] ${operation} failed: status=${status} type=${type}`);
    throw asUpstreamAiError(error);
  }
};

module.exports = {
  createAnthropicClient,
  getAnthropicClientOptions,
  asUpstreamAiError,
  withAnthropicErrors,
};
