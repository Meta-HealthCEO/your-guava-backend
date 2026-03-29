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
    },
    category: {
      type: String,
      enum: ['coffee', 'food', 'cold_drink', 'water', 'retail', 'other'],
      default: 'other',
    },
    avgPrice: {
      type: Number,
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

module.exports = mongoose.model('Item', itemSchema);
