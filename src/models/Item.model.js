const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    name: {
      type: String,
      required: true,
      maxlength: 200,
    },
    normalizedName: {
      type: String,
      index: true,
    },
    aliases: [{ type: String, maxlength: 200 }],
    aliasKeys: [{ type: String, maxlength: 200 }],
    category: {
      type: String,
      enum: ['coffee', 'food', 'cold_drink', 'water', 'retail', 'other'],
      default: 'other',
    },
    expectedPrice: {
      type: Number,
      min: 0,
      max: 1000000,
    },
    priceTolerancePct: {
      type: Number,
      default: 10,
      min: 0,
      max: 100,
    },
    reviewStatus: {
      type: String,
      enum: ['matched', 'needs_review', 'ignored', 'merged'],
      default: 'needs_review',
      index: true,
    },
    source: {
      type: String,
      enum: ['manual', 'pos', 'imported', 'system'],
      default: 'imported',
    },
    avgPrice: {
      type: Number,
    },
    observedPriceMin: { type: Number },
    observedPriceMax: { type: Number },
    lastObservedPrice: { type: Number },
    lastSeenAt: { type: Date },
    firstSeenAt: { type: Date },
    lastPriceMismatchAt: { type: Date },
    priceMismatchCount: { type: Number, default: 0 },
    notes: { type: String, maxlength: 2000 },
    mergedInto: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Item',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    totalSold: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

itemSchema.index({ cafeId: 1, name: 1 }, { unique: true });
itemSchema.index({ cafeId: 1, normalizedName: 1 });
itemSchema.index({ cafeId: 1, aliasKeys: 1 });

module.exports = mongoose.model('Item', itemSchema);
