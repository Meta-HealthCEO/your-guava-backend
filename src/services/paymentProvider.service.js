const oneGate = require('./onegate.service');
const paystack = require('./paystack.service');

/**
 * Resolves the hosted-checkout provider from PAYMENT_PROVIDER.
 *
 * Paystack is the provider the product runs on. OneGate is kept behind this
 * seam rather than deleted, so an environment can still be pointed back at it
 * by changing one variable, and its existing tests keep passing.
 *
 * Anything else -- unset, or the explicit "mock" -- means no hosted provider,
 * and the callers fall through to their mock-checkout path, which is refused
 * in production by validateEnv.
 */

// Each method delegates at call time rather than capturing the function up
// front. Binding early would freeze whatever the module exported at load, which
// breaks both test doubles and any later reassignment of a provider method.
const PROVIDERS = {
  paystack: {
    name: 'paystack',
    createPaymentKey: (...args) => paystack.createPaymentKey(...args),
    lookupGatewayTransaction: (...args) => paystack.lookupGatewayTransaction(...args),
    hostedCheckoutReturnUrl: (...args) => paystack.hostedCheckoutReturnUrl(...args),
    isConfigured: () => paystack.isConfigured(),
    // Paystack settles through an outbound verify call, so it does not need a
    // publicly reachable callback the way OneGate does.
    requiresPublicCallbackUrl: false,
    /** Paystack needs the customer's email address to open a checkout. */
    requiresCustomerEmail: true,
  },
  onegate: {
    name: 'onegate',
    createPaymentKey: (...args) => oneGate.createPaymentKey(...args),
    lookupGatewayTransaction: (...args) => oneGate.lookupGatewayTransaction(...args),
    hostedCheckoutReturnUrl: (...args) => oneGate.hostedCheckoutReturnUrl(...args),
    isConfigured: () => oneGate.isOneGateConfigured(),
    requiresPublicCallbackUrl: true,
    requiresCustomerEmail: false,
  },
};

const providerName = () => (process.env.PAYMENT_PROVIDER || '').trim().toLowerCase();

/** The active provider, or null when no hosted provider is selected. */
const getProvider = () => PROVIDERS[providerName()] || null;

/** True when a hosted provider is selected, regardless of whether it is configured. */
const isHostedCheckoutEnabled = () => Boolean(getProvider());

/** True when a hosted provider is selected and has its credentials. */
const isHostedCheckoutConfigured = () => {
  const provider = getProvider();
  return Boolean(provider && provider.isConfigured());
};

/**
 * The provider a given payment session was opened with.
 *
 * Verification has to go back to whoever took the money, so the session's own
 * provider wins over the current environment — otherwise switching
 * PAYMENT_PROVIDER would strand every in-flight payment. Falls back to the
 * active provider, then to OneGate for sessions written before the provider
 * was recorded. Nothing can be *created* without a configured provider, so this
 * fallback only ever affects reconciliation of existing sessions.
 */
const providerForSession = (session) =>
  PROVIDERS[(session?.provider || '').toLowerCase()] || getProvider() || PROVIDERS.onegate;

const requireProvider = () => {
  const provider = getProvider();
  if (!provider) {
    const err = new Error('No card payment provider is configured');
    err.statusCode = 503;
    throw err;
  }
  return provider;
};

module.exports = {
  PROVIDERS,
  getProvider,
  providerName,
  isHostedCheckoutEnabled,
  isHostedCheckoutConfigured,
  requireProvider,
  providerForSession,
};
