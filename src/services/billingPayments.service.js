const crypto = require('crypto');
const Organization = require('../models/Organization.model');
const PaymentSession = require('../models/PaymentSession.model');
const { getPlan, nextMonthlyAnniversary } = require('./billingPlans.service');
const paymentProvider = require('./paymentProvider.service');
const User = require('../models/User.model');
const { getPlanCapacity } = require('./planCapacity.service');
const { bonusUsedForCredits } = require('./usage.service');
const { invalidateFutureForecastsForOrg, billingPeriodForPayment } = require('./billing/periods');

const PROCESSING_LEASE_MS = 2 * 60 * 1000;
const INITIALIZATION_LEASE_MS = 60 * 1000;
const DEFAULT_RECONCILIATION_AGE_MS = 2 * 60 * 1000;
const DEFAULT_RECONCILIATION_BATCH_SIZE = 20;
const MAX_IDEMPOTENCY_KEY_LENGTH = 160;
// A handful of retries absorbs a transient database or concurrency failure;
// beyond that the failure is structural and hiding it in a retry loop is worse
// than surfacing it.
const MAX_FULFILLMENT_FAILURES = 3;
// A checkout the customer never completed must stop consuming sweep slots, or
// a genuinely paid session queued behind them waits minutes to be reconciled.
const PENDING_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const paymentInitiationError = (message, code, statusCode = 400, details = {}) => {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.details = { code, ...details };
  return err;
};

const normalizePaymentIdempotencyKey = (value) => {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!key) {
    throw paymentInitiationError(
      'Idempotency-Key is required for card payment requests',
      'PAYMENT_IDEMPOTENCY_KEY_REQUIRED'
    );
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || /[\u0000-\u001f\u007f]/.test(key)) {
    throw paymentInitiationError(
      `Idempotency-Key must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} printable characters`,
      'PAYMENT_IDEMPOTENCY_KEY_INVALID'
    );
  }
  return key;
};

const paymentRequestFingerprint = ({ kind, plan, billingCycle, credits, amount }) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify({
      kind,
      plan: plan || null,
      billingCycle: billingCycle || null,
      credits: credits == null ? null : Number(credits),
      amount: Number(amount || 0).toFixed(2),
      currency: 'ZAR',
    }))
    .digest('hex');

const generateReference = (kind = 'plan') => {
  const marker = kind === 'credits' ? 'C' : 'P';
  return `GG${marker}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
};


const cardDetailsFromTransaction = (transaction) => {
  // Paystack reports the card under `authorization` with discrete fields.
  // OneGate returns a masked PAN inside its gateway response parameters, so the
  // brand and last four have to be picked out of loose strings.
  const authorization = transaction?.authorization;
  if (authorization?.last4 || authorization?.brand) {
    const brand = String(authorization.brand || '').trim().toLowerCase();
    const last4 = String(authorization.last4 || '').trim();
    return {
      ...(brand ? { brand } : {}),
      ...(last4 ? { last4 } : {}),
      provider: paymentProvider.providerName() || 'paystack',
    };
  }

  const params = transaction?.gateway_response_parameters || transaction?.gateway_response || {};
  if (typeof params !== 'object') return null;
  const maskedCard = String(params.card || params.Card || '');
  const last4Match = maskedCard.match(/(\d{4})\D*$/);
  const last4 = last4Match?.[1];
  const brand = String(params.cardName || params.card_name || params.cardBrand || '')
    .trim()
    .toLowerCase();

  if (!brand && !last4) return null;
  return {
    ...(brand ? { brand } : {}),
    ...(last4 ? { last4 } : {}),
    provider: paymentProvider.providerName() || 'onegate',
  };
};


const appliedReferences = (org) => (org?.fulfilledPaymentReferences || []).map(String);

/**
 * Reports a plan that the organisation has already outgrown.
 *
 * Capacity is enforced before the customer is sent to checkout. Re-checking it
 * after the card has been captured could only ever refuse money that is already
 * taken, so an organisation that outgrew the plan while the checkout page was
 * open gets the plan it paid for and an operational warning instead. The
 * account payload already reports used-versus-included seats and locations, so
 * the owner sees the same overage and the ordinary limits stop it growing.
 */
const warnOnOverCapacityPlan = async (orgId, previousPlanId, nextPlanId) => {
  const previousPlan = getPlan(previousPlanId);
  const nextPlan = getPlan(nextPlanId);
  if (
    nextPlan.includedSeats >= previousPlan.includedSeats &&
    nextPlan.includedLocations >= previousPlan.includedLocations
  ) {
    return;
  }
  const capacity = await getPlanCapacity(orgId, nextPlan.id);
  if (!capacity.seats.exceeded && !capacity.locations.exceeded) return;
  console.warn(
    `[billing] org ${orgId} is over capacity on the paid ${nextPlan.id} plan:`,
    `${capacity.seats.used}/${capacity.seats.included} seats,`,
    `${capacity.locations.used}/${capacity.locations.included} locations`
  );
};

const applyPlanPayment = async (paymentSession, transaction) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const org = await Organization.findById(paymentSession.orgId).select('+fulfilledPaymentReferences');
    if (!org) {
      const err = new Error('Organization not found');
      err.statusCode = 404;
      throw err;
    }
    if (appliedReferences(org).includes(paymentSession.reference)) {
      return { org, applied: false, planChanged: false };
    }

    const selectedPlan = getPlan(paymentSession.plan);
    const planChanged = org.plan !== selectedPlan.id;
    const now = new Date();
    const period = billingPeriodForPayment(org, paymentSession.billingCycle, now);
    // The allowance window runs from the subscription anniversary, so a new
    // paid period starts a full window rather than a stub that expires at the
    // next calendar rollover and then grants a second allowance.
    const resetAt = nextMonthlyAnniversary(period.currentPeriodStart, now);
    const existingPeriodEnd = org.currentPeriodEnd ? new Date(org.currentPeriodEnd) : null;
    const existingResetAt = org.aiCredits?.resetAt ? new Date(org.aiCredits.resetAt) : null;
    const hasLivePaidPeriod =
      org.billingStatus === 'active' && existingPeriodEnd && existingPeriodEnd > now;
    const resetCredits =
      !hasLivePaidPeriod || !existingResetAt || existingResetAt <= now;
    const bonusUsed = bonusUsedForCredits(org);
    const paymentMethod = cardDetailsFromTransaction(transaction);
    const creditUpdates = {
      'aiCredits.included': selectedPlan.includedGuavaCredits ?? selectedPlan.includedAiCredits,
      ...(resetCredits
        ? {
            'aiCredits.bonusUsed': bonusUsed,
            'aiCredits.used': bonusUsed,
            'aiCredits.resetAt': resetAt,
          }
        : {}),
    };

    const updated = await Organization.findOneAndUpdate(
      {
        _id: org._id,
        __v: org.__v,
        fulfilledPaymentReferences: { $ne: paymentSession.reference },
      },
      {
        $set: {
          plan: selectedPlan.id,
          billingCycle: period.billingCycle,
          billingStatus: 'active',
          subscriptionStartedAt: org.subscriptionStartedAt || now,
          currentPeriodStart: period.currentPeriodStart,
          currentPeriodEnd: period.currentPeriodEnd,
          cancelAtPeriodEnd: false,
          ...(paymentMethod ? { paymentMethod } : {}),
          ...creditUpdates,
        },
        $addToSet: { fulfilledPaymentReferences: paymentSession.reference },
        $inc: { __v: 1 },
      },
      { new: true, runValidators: true }
    ).select('+fulfilledPaymentReferences');

    if (updated) {
      await warnOnOverCapacityPlan(org._id, org.plan, selectedPlan.id).catch(() => null);
      return { org: updated, applied: true, planChanged };
    }
  }

  throw new Error('Could not apply plan payment after concurrent billing updates');
};

const applyCreditPayment = async (paymentSession) => {
  const org = await Organization.findOneAndUpdate(
    {
      _id: paymentSession.orgId,
      fulfilledPaymentReferences: { $ne: paymentSession.reference },
    },
    {
      $inc: {
        'aiCredits.bonus': Math.max(0, Number(paymentSession.credits) || 0),
        __v: 1,
      },
      $addToSet: { fulfilledPaymentReferences: paymentSession.reference },
    },
    { new: true, runValidators: true }
  ).select('+fulfilledPaymentReferences');

  if (org) return { org, applied: true, planChanged: false };
  const existing = await Organization.findById(paymentSession.orgId).select('+fulfilledPaymentReferences');
  if (!existing) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }
  if (appliedReferences(existing).includes(paymentSession.reference)) {
    return { org: existing, applied: false, planChanged: false };
  }
  throw new Error('Could not apply Guava Credit payment');
};

const transactionSuccessFlag = (transaction) =>
  transaction?.successful ?? transaction?.success;

const isExplicitSuccess = (value) => [true, 1, '1'].includes(value);
const isExplicitFailure = (value) => [false, 0, '0'].includes(value);

const isPaidTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  const success = transactionSuccessFlag(transaction);
  if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) return false;
  if (isExplicitFailure(success)) return false;
  return isExplicitSuccess(success) || status === 'complete';
};

const isFailedTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  return ['failed', 'cancelled', 'canceled', 'error'].includes(status) ||
    isExplicitFailure(transactionSuccessFlag(transaction));
};

const validateTransactionForSession = (paymentSession, transaction) => {
  if (!transaction) return false;
  const txReference = transaction.merchant_reference || transaction.reference;
  const txAmount = Number(transaction.amount || 0);
  const txCurrency = String(transaction.currency || transaction.currency_code || '').toUpperCase();
  return (
    txReference === paymentSession.reference &&
    Math.abs(txAmount - paymentSession.amount) < 0.01 &&
    (!txCurrency || txCurrency === String(paymentSession.currency || 'ZAR').toUpperCase())
  );
};

const providerTransactionId = (transaction) => String(
  transaction?.callpay_transaction_id || transaction?.id || ''
);

const safeProviderPayload = (transaction) => ({
  id: providerTransactionId(transaction) || undefined,
  status: transaction?.status,
  successful: transaction?.successful ?? transaction?.success,
  amount: transaction?.amount,
  currency: transaction?.currency || transaction?.currency_code,
  merchant_reference: transaction?.merchant_reference || transaction?.reference,
  gateway_reference: transaction?.gateway_reference,
});

const safeWebhookPayload = (payload) => {
  if (!payload) return undefined;
  return {
    merchant_reference: payload.merchant_reference || payload.reference,
    status: payload.status,
    successful: payload.successful ?? payload.success,
  };
};

const sessionFieldsFromTransaction = (transaction) => ({
  providerTransactionId: providerTransactionId(transaction) || undefined,
  gatewayReference: transaction?.gateway_reference,
  providerStatus: transaction?.status,
  providerReason: transaction?.reason,
  providerPayload: { transaction: safeProviderPayload(transaction) },
});

const paymentSessionNotFound = () => {
  const err = new Error('Payment session not found');
  err.statusCode = 404;
  return err;
};

/**
 * Coerces a payment reference from an untrusted source into a plain string.
 *
 * References arrive on unauthenticated webhook routes and are used to build a
 * Mongoose filter. Mongoose reads an object containing $ operators as query
 * syntax rather than a value to cast, so a body of {"merchant_reference":
 * {"$ne": null}} selected an arbitrary PaymentSession belonging to any tenant.
 * Anything that is not a sane non-empty string is refused outright.
 */
const MAX_REFERENCE_LENGTH = 128;

const normalizePaymentReference = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_REFERENCE_LENGTH) return null;
  return trimmed;
};

const invalidPaymentReference = () => {
  const err = new Error('A valid payment reference is required');
  err.statusCode = 400;
  return err;
};

const claimPaymentSession = async (reference, webhookPayload, { orgId } = {}) => {
  // Defence in depth: even though callers normalise, this is the last point
  // before an attacker-influenced value reaches a database filter.
  const safeReference = normalizePaymentReference(reference);
  if (!safeReference) throw invalidPaymentReference();
  const lookup = { reference: safeReference, ...(orgId ? { orgId } : {}) };
  const existing = await PaymentSession.findOne(lookup);
  if (!existing) throw paymentSessionNotFound();
  if (existing.status === 'paid') return { session: existing, claimed: false };
  if (existing.initializationStatus === 'initializing') {
    return { session: existing, claimed: false };
  }

  const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const claimed = await PaymentSession.findOneAndUpdate(
    {
      _id: existing._id,
      initializationStatus: { $ne: 'initializing' },
      $or: [
        { status: { $in: ['pending', 'failed', 'cancelled'] } },
        { status: 'processing', processingStartedAt: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        status: 'processing',
        processingStartedAt: new Date(),
        ...(webhookPayload ? { providerPayload: { webhook: safeWebhookPayload(webhookPayload) } } : {}),
      },
      $inc: { fulfillmentAttempts: 1 },
      $unset: { failedAt: 1 },
    },
    { new: true, runValidators: true }
  );

  if (claimed) return { session: claimed, claimed: true };
  return { session: await PaymentSession.findById(existing._id), claimed: false };
};

/**
 * Records a capture that could not be applied.
 *
 * A confirmed capture with no plan or credits delivered is money taken for
 * nothing, and releasing it back to `pending` makes the 60-second sweeper retry
 * the same failure forever with no dead-letter state and no alert. After a
 * bounded number of genuine fulfilment failures the session becomes terminal
 * and visible instead, so a person can refund or fix it.
 */
const recordFulfillmentFailure = async (paymentSession, transaction, error) => {
  const reason = String(error?.message || 'Fulfillment failed').slice(0, 500);
  const failed = await PaymentSession.findOneAndUpdate(
    {
      _id: paymentSession._id,
      status: 'processing',
      processingStartedAt: paymentSession.processingStartedAt,
    },
    {
      $inc: { fulfillmentFailures: 1 },
      $set: { ...sessionFieldsFromTransaction(transaction), providerReason: reason },
    },
    { new: true, runValidators: true }
  );
  // A newer worker owns the lease; it will record its own outcome.
  if (!failed) return null;

  if ((failed.fulfillmentFailures || 0) < MAX_FULFILLMENT_FAILURES) {
    return releaseProcessingSession(
      failed._id,
      paymentSession.processingStartedAt,
      'pending',
      reason
    );
  }

  console.error(
    `[billing] captured payment ${failed.reference} could not be fulfilled after`,
    `${failed.fulfillmentFailures} attempts and needs manual attention:`,
    reason
  );
  return PaymentSession.findOneAndUpdate(
    {
      _id: failed._id,
      status: 'processing',
      processingStartedAt: paymentSession.processingStartedAt,
    },
    {
      $set: { status: 'needs_attention', failedAt: new Date(), providerReason: reason },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );
};

const releaseProcessingSession = (sessionId, processingStartedAt, status = 'pending', reason) =>
  PaymentSession.findOneAndUpdate(
    { _id: sessionId, status: 'processing', processingStartedAt },
    {
      $set: {
        status,
        ...(reason ? { providerReason: String(reason).slice(0, 500) } : {}),
        ...(status === 'failed' || status === 'cancelled' ? { failedAt: new Date() } : {}),
      },
      $unset: { processingStartedAt: 1 },
    },
    { new: true, runValidators: true }
  );

const initializeHostedPaymentSession = async (paymentSession, org) => {
  const leaseStartedAt = new Date(paymentSession.initializationStartedAt);
  try {
    const provider = paymentProvider.requireProvider();
    // Paystack opens checkout against a customer email; OneGate does not take
    // one. Only pay for the lookup when the active provider needs it.
    const email = provider.requiresCustomerEmail
      ? (await User.findById(paymentSession.userId).select('email').lean())?.email
      : undefined;

    const paymentKey = await provider.createPaymentKey({
      reference: paymentSession.reference,
      amount: paymentSession.amount,
      customerReference: org.name,
      email,
    });

    const ready = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSession._id,
        initializationStatus: 'initializing',
        initializationStartedAt: leaseStartedAt,
      },
      {
        $set: {
          initializationStatus: 'ready',
          providerPaymentKey: paymentKey.key,
          checkoutUrl: paymentKey.url,
          redirectOrigin: paymentKey.origin,
          providerPayload: {
            paymentKey: { key: paymentKey.key, url: paymentKey.url, origin: paymentKey.origin },
          },
        },
        $unset: { failedAt: 1, providerReason: 1 },
      },
      { new: true, runValidators: true }
    );
    return ready || PaymentSession.findById(paymentSession._id);
  } catch (error) {
    const failed = await PaymentSession.findOneAndUpdate(
      {
        _id: paymentSession._id,
        initializationStatus: 'initializing',
        initializationStartedAt: leaseStartedAt,
      },
      {
        $set: {
          initializationStatus: 'failed',
          status: 'failed',
          failedAt: new Date(),
          providerReason: String(error.message || 'Checkout initialization failed').slice(0, 500),
        },
      },
      { new: true, runValidators: true }
    );
    // A newer request may have reclaimed an expired initialization lease. The
    // older worker must not overwrite that attempt with its own result.
    if (!failed) return PaymentSession.findById(paymentSession._id);
    throw error;
  }
};

/**
 * Grants a mock credit pack through the same reference-keyed fulfilment a real
 * payment uses.
 *
 * The mock path used to `$inc` the bonus balance directly, with no session and
 * no reference, so a double-click, a retried request or a refreshed tab
 * granted the pack again. Real purchases have been idempotent since
 * `fulfilledPaymentReferences` existed; only the path used for testing and
 * demos was not, which is the path most likely to be clicked twice.
 *
 * Without an Idempotency-Key there is nothing to be idempotent against, and a
 * purchase that 400s because a header is missing is a worse failure than a
 * duplicate, so it still proceeds — just with a session of its own.
 */
const fulfilMockCreditPurchase = async ({ org, userId, credits, amount, idempotencyKey }) => {
  // Validated when supplied, not demanded. `normalizePaymentIdempotencyKey`
  // throws on a missing key because a card payment must never be replayable;
  // a mock grant that 400s on a missing header would be a worse failure than
  // the duplicate it prevents, and no client is obliged to send one today.
  const key = idempotencyKey ? normalizePaymentIdempotencyKey(idempotencyKey) : null;
  const find = () =>
    PaymentSession.findOne({ orgId: org._id, kind: 'credits', idempotencyKey: key });

  let session = key ? await find() : null;
  if (!session) {
    const reference = generateReference('credits');
    try {
      session = await PaymentSession.create({
        orgId: org._id,
        userId,
        provider: 'mock',
        kind: 'credits',
        idempotencyKey: key,
        requestFingerprint: paymentRequestFingerprint({ kind: 'credits', credits, amount }),
        initializationStatus: 'ready',
        reference,
        providerTransactionId: `mock-${reference}`,
        amount,
        currency: 'ZAR',
        credits,
        status: 'pending',
      });
    } catch (error) {
      // Two requests with the same key can race past the findOne above; the
      // unique index on (orgId, kind, idempotencyKey) is what actually decides
      // which one creates the session.
      if (error?.code === 11000 && key) session = await find();
      if (!session) throw error;
    }
  }

  const { org: updated, applied } = await applyCreditPayment(session);

  if (session.status !== 'paid') {
    await PaymentSession.updateOne(
      { _id: session._id },
      { $set: { status: 'paid', paidAt: session.paidAt || new Date() } }
    );
  }

  return { org: updated, session, applied };
};

const createHostedPaymentSession = async ({
  org,
  userId,
  kind,
  plan,
  billingCycle,
  credits,
  amount,
  idempotencyKey,
}) => {
  if (!paymentProvider.isHostedCheckoutConfigured()) {
    const err = new Error('Card payments are not configured');
    err.statusCode = 503;
    throw err;
  }

  const key = normalizePaymentIdempotencyKey(idempotencyKey);
  const requestFingerprint = paymentRequestFingerprint({
    kind,
    plan,
    billingCycle,
    credits,
    amount,
  });
  const reference = generateReference(kind);
  const initializationStartedAt = new Date();
  let paymentSession;
  try {
    paymentSession = await PaymentSession.create({
      orgId: org._id,
      userId,
      provider: paymentProvider.providerName(),
      kind,
      idempotencyKey: key,
      requestFingerprint,
      initializationStatus: 'initializing',
      initializationStartedAt,
      initializationAttempts: 1,
      reference,
      amount,
      currency: 'ZAR',
      plan,
      billingCycle,
      credits,
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const existing = await PaymentSession.findOne({
      orgId: org._id,
      kind,
      idempotencyKey: key,
    });
    if (!existing) throw error;
    const existingFingerprint = existing.requestFingerprint || paymentRequestFingerprint(existing);
    if (existingFingerprint !== requestFingerprint) {
      throw paymentInitiationError(
        'Idempotency-Key was already used for a different payment request',
        'PAYMENT_IDEMPOTENCY_CONFLICT',
        409,
        { reference: existing.reference }
      );
    }
    const staleBefore = new Date(Date.now() - INITIALIZATION_LEASE_MS);
    paymentSession = await PaymentSession.findOneAndUpdate(
      {
        _id: existing._id,
        initializationStatus: 'initializing',
        $or: [
          { initializationStartedAt: { $lte: staleBefore } },
          {
            initializationStartedAt: { $exists: false },
            createdAt: { $lte: staleBefore },
          },
        ],
      },
      {
        $set: { initializationStartedAt: new Date() },
        $unset: { failedAt: 1, providerReason: 1 },
        $inc: { initializationAttempts: 1 },
      },
      { new: true, runValidators: true }
    );
    if (!paymentSession) return PaymentSession.findById(existing._id);
  }

  return initializeHostedPaymentSession(paymentSession, org);
};

const reconcileOneGatePayment = async (reference, webhookPayload = null, options = {}) => {
  const { session: paymentSession, claimed } = await claimPaymentSession(
    reference,
    webhookPayload,
    options
  );
  if (!claimed) return paymentSession;

  let financialEffectApplied = false;
  try {
    const transaction = await paymentProvider
      .providerForSession(paymentSession)
      .lookupGatewayTransaction(reference);
    if (!validateTransactionForSession(paymentSession, transaction)) {
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        'Provider transaction did not match payment session'
      );
      const err = new Error('Payment could not be verified with OneGate');
      err.statusCode = 202;
      throw err;
    }

    if (isPaidTransaction(transaction)) {
      let result;
      try {
        result = paymentSession.kind === 'plan'
          ? await applyPlanPayment(paymentSession, transaction)
          : await applyCreditPayment(paymentSession);
      } catch (fulfillmentError) {
        await recordFulfillmentFailure(paymentSession, transaction, fulfillmentError)
          .catch(() => null);
        throw fulfillmentError;
      }
      financialEffectApplied = true;

      const paid = await PaymentSession.findOneAndUpdate(
        {
          _id: paymentSession._id,
          status: 'processing',
          processingStartedAt: paymentSession.processingStartedAt,
        },
        {
          $set: {
            ...sessionFieldsFromTransaction(transaction),
            status: 'paid',
            paidAt: new Date(),
          },
          $unset: { processingStartedAt: 1, failedAt: 1 },
        },
        { new: true, runValidators: true }
      );
      if (!paid) throw new Error('Payment session changed while fulfillment was completing');

      if (result.planChanged) {
        invalidateFutureForecastsForOrg(paymentSession.orgId).catch((error) => {
          console.error('[billing] forecast invalidation failed:', error.message);
        });
      }
      return paid;
    }

    if (isFailedTransaction(transaction)) {
      const failedStatus = String(transaction?.status || '').toLowerCase().includes('cancel')
        ? 'cancelled'
        : 'failed';
      return PaymentSession.findOneAndUpdate(
        {
          _id: paymentSession._id,
          status: 'processing',
          processingStartedAt: paymentSession.processingStartedAt,
        },
        {
          $set: {
            ...sessionFieldsFromTransaction(transaction),
            status: failedStatus,
            failedAt: new Date(),
          },
          $unset: { processingStartedAt: 1 },
        },
        { new: true, runValidators: true }
      );
    }

    return releaseProcessingSession(
      paymentSession._id,
      paymentSession.processingStartedAt,
      'pending'
    );
  } catch (error) {
    if (error.statusCode !== 202) {
      await releaseProcessingSession(
        paymentSession._id,
        paymentSession.processingStartedAt,
        'pending',
        financialEffectApplied ? 'Fulfillment recorded; finalization will retry' : error.message
      ).catch(() => null);
    }
    throw error;
  }
};

const reconcilePendingOneGatePayments = async ({
  now = new Date(),
  minAgeMs = DEFAULT_RECONCILIATION_AGE_MS,
  limit = DEFAULT_RECONCILIATION_BATCH_SIZE,
  concurrency = 4,
} = {}) => {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_RECONCILIATION_BATCH_SIZE, 100));
  const boundedConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 10));
  const pendingBefore = new Date(now.getTime() - Math.max(30_000, Number(minAgeMs) || 0));
  const staleProcessingBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
  const expiredBefore = new Date(now.getTime() - PENDING_SESSION_TTL_MS);
  const hostedProviders = paymentProvider.hostedProviderNames();

  // Retire checkouts the customer abandoned. Nothing is lost by doing so: the
  // provider never recorded a transaction against them, and if one ever settles
  // late the return or webhook can still claim a cancelled session.
  await PaymentSession.updateMany(
    {
      provider: { $in: hostedProviders },
      status: 'pending',
      providerTransactionId: { $exists: false },
      createdAt: { $lt: expiredBefore },
    },
    {
      $set: {
        status: 'cancelled',
        failedAt: now,
        providerReason: 'Checkout expired without payment',
      },
    }
  );

  const sessions = await PaymentSession.find({
    // Every hosted provider needs reconciling, not just the original one. A
    // name hard-coded here silently strands the other provider's payments.
    provider: { $in: hostedProviders },
    $and: [
      {
        $or: [
          { initializationStatus: 'ready' },
          { initializationStatus: { $exists: false } },
        ],
      },
      {
        $or: [
          {
            status: 'pending',
            updatedAt: { $lte: pendingBefore },
            createdAt: { $gte: expiredBefore },
          },
          { status: 'processing', processingStartedAt: { $lt: staleProcessingBefore } },
        ],
      },
    ],
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(boundedLimit)
    .select('reference')
    .lean();

  const summary = { scanned: sessions.length, paid: 0, pending: 0, failed: 0, errors: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < sessions.length) {
      const index = cursor;
      cursor += 1;
      const candidate = sessions[index];
      try {
        const reconciled = await reconcileOneGatePayment(candidate.reference);
        if (reconciled?.status === 'paid') summary.paid += 1;
        else if (['failed', 'cancelled'].includes(reconciled?.status)) summary.failed += 1;
        else summary.pending += 1;
      } catch (error) {
        if (error.statusCode === 202) summary.pending += 1;
        else summary.errors += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(boundedConcurrency, sessions.length) }, () => worker())
  );
  return summary;
};

const getCreditPack = (org, requestedCredits) => {
  const plan = getPlan(org.plan);
  const pack = (plan.creditPackOptions || []).find((option) => option.credits === Number(requestedCredits));
  if (pack) return pack;

  return (plan.creditPackOptions || [])[0] || {
    credits: 500,
    price: plan.guavaCreditPackPrice || plan.aiCreditPackPrice || 99,
  };
};

module.exports = {
  billingPeriodForPayment,
  createHostedPaymentSession,
  fulfilMockCreditPurchase,
  generateReference,
  getCreditPack,
  invalidateFutureForecastsForOrg,
  normalizePaymentIdempotencyKey,
  normalizePaymentReference,
  paymentRequestFingerprint,
  reconcilePendingOneGatePayments,
  reconcileOneGatePayment,
};
