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
    status: {
      type: String,
      enum: ['committed', 'refunded'],
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
  },
  { timestamps: true }
);

usageLedgerSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model('UsageLedger', usageLedgerSchema);
