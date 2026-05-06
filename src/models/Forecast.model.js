const mongoose = require('mongoose');

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
        predictedQty: { type: Number },
        actualQty: { type: Number },
        suggestedStock: { type: Number },
      },
    ],
    signals: {
      weather: {
        temp: { type: Number },
        condition: { type: String },
        humidity: { type: Number },
      },
      loadSheddingStage: { type: Number, default: 0 },
      isPublicHoliday: { type: Boolean, default: false },
      isSchoolHoliday: { type: Boolean, default: false },
      isPayday: { type: Boolean, default: false },
      dayOfWeek: { type: Number },
      events: [{ name: String, impact: String }],
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
