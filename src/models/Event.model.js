const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 160,
    },
    date: {
      type: Date,
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['event', 'closure', 'partial_closure'],
      default: 'event',
      index: true,
    },
    closureWindow: {
      type: new mongoose.Schema(
        {
          startTime: { type: String },
          endTime: { type: String },
        },
        { _id: false }
      ),
      default: undefined,
    },
    impact: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    impactPct: {
      type: Number,
      min: -90,
      max: 200,
    },
    notes: {
      type: String,
      maxlength: 2000,
    },
    recurring: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

eventSchema.index({ cafeId: 1, date: 1 });

module.exports = mongoose.model('Event', eventSchema);
