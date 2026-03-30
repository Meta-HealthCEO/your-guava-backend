const mongoose = require('mongoose');

const cafeSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },
    location: {
      address: { type: String },
      city: { type: String, default: 'Cape Town' },
      lat: { type: Number },
      lng: { type: Number },
    },
    yocoConnected: {
      type: Boolean,
      default: false,
    },
    yocoTokens: {
      accessToken: String,
      refreshToken: String,
      expiresAt: Date,
    },
    yocoBusinessId: String,
    yocoLocationId: String,
    timezone: {
      type: String,
      default: 'Africa/Johannesburg',
    },
    dataUploaded: {
      type: Boolean,
      default: false,
    },
    lastSyncAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cafe', cafeSchema);
