const mongoose = require('mongoose');

const usageLedgerSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    featureKey: {
      type: String,
      required: true,
      index: true,
    },
    label: {
      type: String,
      required: true,
    },
    credits: {
      type: Number,
      required: true,
      min: 0,
    },
    creditAllocation: {
      included: {
        type: Number,
        default: 0,
        min: 0,
      },
      bonus: {
        type: Number,
        default: 0,
        min: 0,
      },
    },
    status: {
      type: String,
      enum: ['reserved', 'recovering', 'committed', 'refunded', 'failed'],
      default: 'committed',
      index: true,
    },
    provider: {
      type: String,
      default: 'guava',
    },
    relatedEntity: {
      kind: String,
      id: String,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    idempotencyKey: {
      type: String,
      maxlength: 160,
    },
    requestFingerprint: {
      type: String,
      maxlength: 64,
    },
    replayCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    recoveryReason: {
      type: String,
      maxlength: 120,
    },
    reservedAt: {
      type: Date,
    },
    creditWindowResetAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

usageLedgerSchema.index({ orgId: 1, createdAt: -1 });
usageLedgerSchema.index({ status: 1, reservedAt: 1 });
usageLedgerSchema.index(
  { orgId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: 'string' } },
  }
);

module.exports = mongoose.model('UsageLedger', usageLedgerSchema);
