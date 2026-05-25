const {
  consumeGuavaCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
} = require('./usage.service');

const consumeAiCredits = (orgId, amount = 1, options = {}) =>
  consumeGuavaCredits(orgId, amount, {
    featureKey: 'ask_guava_chat',
    label: 'Ask Guava answer',
    provider: 'anthropic',
    ...options,
  });

module.exports = {
  consumeAiCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
};
