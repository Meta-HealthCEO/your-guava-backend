const mongoose = require('mongoose');

const integrationOAuthStateSchema = new mongoose.Schema(
  {
    stateHash: {
      type: String,
      required: true,
      unique: true,
      select: false,
    },
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['xero', 'quickbooks', 'sage'],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },
    consumedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

integrationOAuthStateSchema.index({ cafeId: 1, userId: 1, provider: 1, expiresAt: 1 });

module.exports = mongoose.model('IntegrationOAuthState', integrationOAuthStateSchema);
