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
        salesItemId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Item',
        },
        name: { type: String, required: true },
        rawName: { type: String },
        quantity: { type: Number, required: true },
        unitPrice: { type: Number },
        expectedPrice: { type: Number },
        priceVariancePct: { type: Number },
        menuItemStatus: {
          type: String,
          enum: ['matched', 'needs_review', 'price_mismatch', 'ignored'],
          default: 'matched',
        },
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
transactionSchema.index({ cafeId: 1, status: 1, date: -1 });
transactionSchema.index({ cafeId: 1, status: 1, dayOfWeek: 1, date: -1 });
transactionSchema.index({ cafeId: 1, status: 1, dayOfWeek: 1, hour: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
