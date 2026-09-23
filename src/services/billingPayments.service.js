/**
 * Re-export barrel (BE-11-T04). Plan periods live in ./billing/periods.js, hosted
 * sessions in sessions.js, fulfilment in fulfilment.js, reconciliation and its
 * sweeper in reconcile.js. server.js and the startup test import this path.
 */
const periods = require('./billing/periods');
const sessions = require('./billing/sessions');
const fulfilment = require('./billing/fulfilment');
const reconcile = require('./billing/reconcile');

module.exports = {
  billingPeriodForPayment: periods.billingPeriodForPayment,
  createHostedPaymentSession: sessions.createHostedPaymentSession,
  fulfilMockCreditPurchase: fulfilment.fulfilMockCreditPurchase,
  generateReference: sessions.generateReference,
  getCreditPack: sessions.getCreditPack,
  invalidateFutureForecastsForOrg: periods.invalidateFutureForecastsForOrg,
  normalizePaymentIdempotencyKey: sessions.normalizePaymentIdempotencyKey,
  normalizePaymentReference: sessions.normalizePaymentReference,
  paymentRequestFingerprint: sessions.paymentRequestFingerprint,
  reconcileOneGatePayment: reconcile.reconcileOneGatePayment,
  reconcilePendingOneGatePayments: reconcile.reconcilePendingOneGatePayments,
};
