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
    savedColumnMapping: {
      type: new mongoose.Schema(
        {
          receiptId: { type: String },
          date: { type: String },
          time: { type: String },
          items: { type: String },
          total: { type: String },
          tip: { type: String },
          discount: { type: String },
          paymentMethod: { type: String },
          status: { type: String },
          quantity: { type: String },
          itemsMode: { type: String, enum: ['packed', 'line-per-row'] },
        },
        { _id: false }
      ),
      default: undefined,
    },
    lastSyncAt: {
      type: Date,
    },
    accountingIntegrations: {
      xero: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String },
        refreshToken: { type: String },
        tenantId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
      },
      quickbooks: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String },
        refreshToken: { type: String },
        realmId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
      },
      sage: {
        connected: { type: Boolean, default: false },
        accessToken: { type: String },
        refreshToken: { type: String },
        businessId: { type: String },
        expiresAt: { type: Date },
        connectedAt: { type: Date },
        lastSyncAt: { type: Date },
        lastSyncStatus: { type: String, enum: ['success', 'failed', null], default: null },
        lastSyncError: { type: String },
      },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Cafe', cafeSchema);
