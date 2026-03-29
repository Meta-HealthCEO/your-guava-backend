const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    receiptId: {
      type: String,
      required: true,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    hour: {
      type: Number, // 0-23
    },
    dayOfWeek: {
      type: Number, // 0=Sunday, 6=Saturday
    },
    status: {
      type: String,
      enum: ['approved', 'declined', 'error', 'aborted'],
      default: 'approved',
    },
    paymentMethod: {
      type: String,
    },
    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        unitPrice: { type: Number },
      },
    ],
    total: {
      type: Number,
    },
    tip: {
      type: Number,
      default: 0,
    },
    discount: {
      type: Number,
      default: 0,
    },
    source: {
      type: String,
      enum: ['csv', 'api', 'manual'],
      default: 'csv',
    },
  },
  { timestamps: true }
);

// Compound unique index to prevent duplicate imports
transactionSchema.index({ cafeId: 1, receiptId: 1 }, { unique: true });
// Query index for date range lookups
transactionSchema.index({ cafeId: 1, date: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
