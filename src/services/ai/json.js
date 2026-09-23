// Model output: validated insight strings and the provider diagnostics attached to a response.
// Moved from anthropic.service.js by BE-11-T02; behaviour unchanged.
const { modelId } = require('./prompts');

const providerDiagnostics = (response, startedAt, operation) => ({
  operation,
  model: response?.model || modelId(),
  providerRequestId: response?.id,
  inputTokens: Number(response?.usage?.input_tokens) || 0,
  outputTokens: Number(response?.usage?.output_tokens) || 0,
  // Without these two, a regression that drops the cache hit rate to zero —
  // the whole business context re-billed at full input price on every turn —
  // is invisible in the ledger.
  cacheCreationInputTokens: Number(response?.usage?.cache_creation_input_tokens) || 0,
  cacheReadInputTokens: Number(response?.usage?.cache_read_input_tokens) || 0,
  stopReason: response?.stop_reason,
  latencyMs: Math.max(0, Date.now() - startedAt),
});

/**
 * Reduces a parsed provider response to the insight strings we will store.
 *
 * The equality check this replaced (`insights.length !== value.length`) fired
 * on exactly the cases the `slice` exists to handle: eleven perfectly usable
 * insights, or nine good ones plus a stray object, were both rejected whole and
 * shown to the owner as an AI failure. Drop what we cannot store and keep what
 * we can; only a response with nothing usable, or one carrying a string longer
 * than the schema allows, is a real failure.
 */
const validatedInsightStrings = (value) => {
  if (!Array.isArray(value)) return null;
  const insights = value
    .filter((entry) => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (insights.length < 1) return null;
  if (insights.some((entry) => entry.length > 4000)) return null;
  return insights.slice(0, 10);
};

module.exports = {
  providerDiagnostics, validatedInsightStrings,
};
