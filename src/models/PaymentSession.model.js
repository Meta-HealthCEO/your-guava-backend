const mongoose = require('mongoose');

const paymentSessionSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    provider: {
      type: String,
      enum: ['mock', 'onegate'],
      required: true,
      default: 'onegate',
    },
    kind: {
      type: String,
      enum: ['plan', 'credits'],
      required: true,
    },
    idempotencyKey: {
      type: String,
      maxlength: 160,
    },
    requestFingerprint: {
      type: String,
      maxlength: 64,
    },
    initializationStatus: {
      type: String,
      enum: ['initializing', 'ready', 'failed'],
      default: 'ready',
      index: true,
    },
    initializationStartedAt: {
      type: Date,
    },
    initializationAttempts: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'failed', 'cancelled'],
      default: 'pending',
      index: true,
    },
    reference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: 'ZAR',
    },
    plan: {
      type: String,
      enum: ['starter', 'growth', 'pro'],
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'annual'],
    },
    credits: {
      type: Number,
    },
    providerPaymentKey: {
      type: String,
    },
    providerTransactionId: {
      type: String,
    },
    gatewayReference: {
      type: String,
    },
    checkoutUrl: {
      type: String,
    },
    redirectOrigin: {
      type: String,
    },
    providerStatus: {
      type: String,
    },
    providerReason: {
      type: String,
    },
    providerPayload: {
      type: mongoose.Schema.Types.Mixed,
    },
    paidAt: {
      type: Date,
    },
    failedAt: {
      type: Date,
    },
    processingStartedAt: {
      type: Date,
    },
    fulfillmentAttempts: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

paymentSessionSchema.index(
  { provider: 1, providerTransactionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerTransactionId: { $type: 'string' } },
  }
);
paymentSessionSchema.index(
  { orgId: 1, kind: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);
paymentSessionSchema.index({ provider: 1, initializationStatus: 1, status: 1, updatedAt: 1 });

module.exports = mongoose.model('PaymentSession', paymentSessionSchema);
