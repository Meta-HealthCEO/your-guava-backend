const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: String,
      enum: ['free', 'starter', 'growth', 'pro'],
      default: 'starter',
    },
    billingStatus: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'canceled'],
      default: 'trialing',
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'annual'],
      default: 'monthly',
    },
    billingEmail: {
      type: String,
      lowercase: true,
      trim: true,
    },
    mockCustomerId: {
      type: String,
    },
    paymentMethod: {
      brand: { type: String, default: 'visa' },
      last4: { type: String, default: '4242' },
      expiresAt: { type: String, default: '12/30' },
      provider: { type: String, default: 'mock' },
    },
    aiCredits: {
      included: { type: Number, default: 400 },
      bonus: { type: Number, default: 0 },
      used: { type: Number, default: 0 },
      resetAt: {
        type: Date,
        default: () => {
          const resetAt = new Date();
          resetAt.setMonth(resetAt.getMonth() + 1);
          resetAt.setDate(1);
          resetAt.setHours(0, 0, 0, 0);
          return resetAt;
        },
      },
    },
    subscriptionStartedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Organization', organizationSchema);
