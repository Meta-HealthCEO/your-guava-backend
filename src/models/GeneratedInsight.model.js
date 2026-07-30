const mongoose = require('mongoose');

const generatedInsightSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      unique: true,
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    insights: {
      type: [{
        type: String,
        trim: true,
        maxlength: 4000,
      }],
      default: [],
      validate: {
        validator: (values) => values.length <= 10,
        message: 'At most 10 generated insights can be stored',
      },
    },
    generatedAt: {
      type: Date,
      default: null,
      index: true,
    },
    invalidatedAt: {
      type: Date,
      default: null,
    },
    providerDiagnostics: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
    refreshLease: {
      token: { type: String, maxlength: 80 },
      expiresAt: { type: Date },
    },
  },
  { timestamps: true }
);

generatedInsightSchema.index({ orgId: 1, generatedAt: -1 });
generatedInsightSchema.index({ 'refreshLease.expiresAt': 1 });

module.exports = mongoose.model('GeneratedInsight', generatedInsightSchema);
