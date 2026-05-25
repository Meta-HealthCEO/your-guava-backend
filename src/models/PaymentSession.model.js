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
    status: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'cancelled'],
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('PaymentSession', paymentSessionSchema);
