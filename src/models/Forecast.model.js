const mongoose = require('mongoose');

const factorSchema = new mongoose.Schema(
  {
    key: { type: String },
    label: { type: String },
    active: { type: Boolean, default: false },
    adjustmentPct: { type: Number },
    multiplier: { type: Number },
    effect: { type: String },
    reason: { type: String },
  },
  { _id: false }
);

const calibrationEntrySchema = new mongoose.Schema(
  {
    key: { type: String },
    label: { type: String },
    itemName: { type: String },
    multiplier: { type: Number },
    sampleSize: { type: Number },
    averageRatio: { type: Number },
  },
  { _id: false }
);

const forecastSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    items: [
      {
        itemName: { type: String },
        baseQty: { type: Number },
        predictedQty: { type: Number },
        actualQty: { type: Number },
        suggestedStock: { type: Number },
        factors: [factorSchema],
      },
    ],
    signals: {
      weather: {
        temp: { type: Number },
        condition: { type: String },
        humidity: { type: Number },
        isRain: { type: Boolean },
        precipMm: { type: Number },
        chanceOfRain: { type: Number },
      },
      loadSheddingStage: { type: Number, default: 0 },
      isPublicHoliday: { type: Boolean, default: false },
      isSchoolHoliday: { type: Boolean, default: false },
      isPayday: { type: Boolean, default: false },
      dayOfWeek: { type: Number },
      events: [{ name: String, impact: String, impactPct: Number }],
    },
    factors: [factorSchema],
    factorSettings: {
      type: mongoose.Schema.Types.Mixed,
    },
    factorEntitlements: {
      type: mongoose.Schema.Types.Mixed,
    },
    calibration: {
      lookbackDays: { type: Number },
      sampleSize: { type: Number },
      overallMultiplier: { type: Number },
      factorMultipliers: [calibrationEntrySchema],
      itemMultipliers: [calibrationEntrySchema],
      generatedAt: { type: Date },
    },
    totalPredictedRevenue: {
      type: Number,
    },
    actualRevenue: {
      type: Number,
    },
    actualTransactionCount: {
      type: Number,
    },
    actualsUpdatedAt: {
      type: Date,
    },
    accuracy: {
      type: Number, // percentage, populated after actuals come in
    },
    trainingData: {
      transactionCount: { type: Number, default: 0 },
      firstTransactionDate: { type: Date },
      lastTransactionDate: { type: Date },
      weeksWithSales: { type: Number, default: 0 },
      staleDays: { type: Number },
    },
  },
  { timestamps: true }
);

forecastSchema.index({ cafeId: 1, date: 1 }, { unique: true });

module.exports = mongoose.model('Forecast', forecastSchema);
