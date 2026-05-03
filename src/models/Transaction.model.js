const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    uploadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Upload',
      index: true,
    },
    receiptId: { type: String },
    dedupKey: { type: String },
    date: { type: Date, required: true, index: true },
    hour: { type: Number },
    dayOfWeek: { type: Number },
    status: {
      type: String,
      enum: ['approved', 'declined', 'error', 'aborted'],
      default: 'approved',
    },
    paymentMethod: { type: String },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        unitPrice: { type: Number },
      },
    ],
    total: { type: Number },
    tip: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    source: {
      type: String,
      enum: ['csv', 'api', 'manual'],
      default: 'csv',
    },
  },
  { timestamps: true }
);

// Sparse-unique compound indexes — at most one of receiptId/dedupKey should be set per row.
transactionSchema.index(
  { cafeId: 1, receiptId: 1 },
  { unique: true, partialFilterExpression: { receiptId: { $type: 'string' } } }
);
transactionSchema.index(
  { cafeId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } }
);
transactionSchema.index({ cafeId: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
