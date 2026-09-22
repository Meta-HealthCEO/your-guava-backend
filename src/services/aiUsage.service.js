const {
  consumeGuavaCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
} = require('./usage.service');

/**
 * Charges Guava Credits for an Ask Guava answer.
 *
 * The idempotency key is mandatory rather than optional on purpose. This helper
 * reads like a "just charge N credits" call, and the paid AI routes are exactly
 * where a client retry is expected — a keyless charge would bill twice for one
 * answer. Refuse at the boundary instead of leaving that to the caller.
 */
const consumeAiCredits = (orgId, amount = 1, options = {}) => {
  if (!options.idempotencyKey) {
    const error = new Error('An idempotency key is required to charge Guava Credits');
    error.statusCode = 400;
    error.code = 'USAGE_IDEMPOTENCY_KEY_REQUIRED';
    return Promise.reject(error);
  }

  return consumeGuavaCredits(orgId, amount, {
    featureKey: 'ask_guava_chat',
    label: 'Ask Guava answer',
    provider: 'anthropic',
    ...options,
  });
};

module.exports = {
  consumeAiCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
};
