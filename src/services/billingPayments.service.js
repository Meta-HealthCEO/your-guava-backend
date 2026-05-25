const crypto = require('crypto');
const Cafe = require('../models/Cafe.model');
const Forecast = require('../models/Forecast.model');
const Organization = require('../models/Organization.model');
const PaymentSession = require('../models/PaymentSession.model');
const { getPlan, nextCreditResetDate } = require('./billingPlans.service');
const { ensureFreshCreditWindow } = require('./usage.service');
const oneGate = require('./onegate.service');

const generateReference = (kind = 'plan') => {
  const marker = kind === 'credits' ? 'C' : 'P';
  return `GG${marker}${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
};

const invalidateFutureForecastsForOrg = async (orgId) => {
  const cafes = await Cafe.find({ orgId }).select('_id').lean();
  if (cafes.length === 0) return;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  await Forecast.deleteMany({
    cafeId: { $in: cafes.map((cafe) => cafe._id) },
    date: { $gte: today },
  });
};

const cardDetailsFromTransaction = (transaction) => {
  const params = transaction?.gateway_response_parameters || transaction?.gateway_response || {};
  const maskedCard = String(params.card || params.Card || '');
  const last4Match = maskedCard.match(/(\d{4})\D*$/);
  const last4 = last4Match?.[1];
  const brand = String(params.cardName || params.card_name || params.cardBrand || 'card').toLowerCase();

  return {
    brand: brand || 'card',
    last4: last4 || '0000',
    expiresAt: '',
    provider: 'onegate',
  };
};

const applyPlanPayment = async (session, transaction) => {
  const org = await Organization.findById(session.orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  const selectedPlan = getPlan(session.plan);
  const planChanged = org.plan !== selectedPlan.id;

  org.plan = selectedPlan.id;
  org.billingCycle = session.billingCycle === 'annual' ? 'annual' : 'monthly';
  org.billingStatus = 'active';
  org.subscriptionStartedAt = org.subscriptionStartedAt || new Date();
  org.paymentMethod = cardDetailsFromTransaction(transaction);
  org.aiCredits = {
    included: selectedPlan.includedGuavaCredits ?? selectedPlan.includedAiCredits,
    bonus: org.aiCredits?.bonus || 0,
    used: 0,
    resetAt: nextCreditResetDate(),
  };
  await org.save();

  if (planChanged) {
    await invalidateFutureForecastsForOrg(org._id);
  }

  return org;
};

const applyCreditPayment = async (session) => {
  const org = await Organization.findById(session.orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  ensureFreshCreditWindow(org);
  org.billingStatus = org.billingStatus === 'canceled' ? 'active' : org.billingStatus;
  org.aiCredits.bonus = (org.aiCredits?.bonus || 0) + (session.credits || 0);
  await org.save();
  return org;
};

const isPaidTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  return transaction?.successful === 1 || transaction?.success === 1 || transaction?.successful === true || status === 'complete';
};

const isFailedTransaction = (transaction) => {
  const status = String(transaction?.status || '').toLowerCase();
  return ['failed', 'cancelled', 'canceled', 'error'].includes(status) || transaction?.successful === 0 || transaction?.success === 0;
};

const validateTransactionForSession = (session, transaction) => {
  if (!transaction) return false;
  const txReference = transaction.merchant_reference || transaction.reference;
  const txAmount = Number(transaction.amount || 0);
  return txReference === session.reference && Math.abs(txAmount - session.amount) < 0.01;
};

const updateSessionFromTransaction = async (session, transaction) => {
  session.providerTransactionId = String(
    transaction?.callpay_transaction_id || transaction?.id || session.providerTransactionId || ''
  );
  session.gatewayReference = transaction?.gateway_reference || session.gatewayReference;
  session.providerStatus = transaction?.status || session.providerStatus;
  session.providerReason = transaction?.reason || session.providerReason;
  session.providerPayload = transaction || session.providerPayload;

  if (isPaidTransaction(transaction)) {
    if (session.status !== 'paid') {
      if (session.kind === 'plan') {
        await applyPlanPayment(session, transaction);
      } else if (session.kind === 'credits') {
        await applyCreditPayment(session);
      }
      session.status = 'paid';
      session.paidAt = new Date();
    }
  } else if (isFailedTransaction(transaction)) {
    session.status = String(transaction?.status || '').toLowerCase().includes('cancel') ? 'cancelled' : 'failed';
    session.failedAt = new Date();
  }

  await session.save();
  return session;
};

const createHostedPaymentSession = async ({ org, userId, kind, plan, billingCycle, credits, amount }) => {
  if (!oneGate.isOneGateConfigured()) {
    const err = new Error('OneGate card payments are not configured');
    err.statusCode = 503;
    throw err;
  }

  const reference = generateReference(kind);
  const session = await PaymentSession.create({
    orgId: org._id,
    userId,
    provider: 'onegate',
    kind,
    reference,
    amount,
    currency: 'ZAR',
    plan,
    billingCycle,
    credits,
  });

  try {
    const paymentKey = await oneGate.createPaymentKey({
      reference,
      amount,
      customerReference: org.name,
    });

    session.providerPaymentKey = paymentKey.key;
    session.checkoutUrl = paymentKey.url;
    session.redirectOrigin = paymentKey.origin;
    session.providerPayload = { paymentKey };
    await session.save();

    return session;
  } catch (error) {
    session.status = 'failed';
    session.failedAt = new Date();
    session.providerReason = error.message;
    await session.save();
    throw error;
  }
};

const reconcileOneGatePayment = async (reference, webhookPayload = null) => {
  const session = await PaymentSession.findOne({ reference });
  if (!session) {
    const err = new Error('Payment session not found');
    err.statusCode = 404;
    throw err;
  }

  if (webhookPayload) {
    session.providerPayload = {
      ...(session.providerPayload || {}),
      webhook: webhookPayload,
    };
    await session.save();
  }

  if (session.status === 'paid') return session;

  const transaction = await oneGate.lookupGatewayTransaction(reference);
  if (!validateTransactionForSession(session, transaction)) {
    const err = new Error('Payment could not be verified with OneGate');
    err.statusCode = 202;
    await session.save();
    throw err;
  }

  return updateSessionFromTransaction(session, transaction);
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
  createHostedPaymentSession,
  generateReference,
  getCreditPack,
  invalidateFutureForecastsForOrg,
  reconcileOneGatePayment,
};
