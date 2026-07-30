const mongoose = require('mongoose');

const columnMappingSchema = new mongoose.Schema(
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
  },
  { _id: false }
);

const rowErrorSchema = new mongoose.Schema(
  {
    rowNumber: { type: Number },
    reason: { type: String, required: true },
    raw: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const uploadSchema = new mongoose.Schema(
  {
    cafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
      required: true,
      index: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    fileName: { type: String, required: true },
    fileSize: { type: Number, required: true },
    r2Key: { type: String, required: true },
    fileFingerprint: {
      type: String,
      match: /^[a-f0-9]{64}$/,
      index: true,
    },
    posType: {
      type: String,
      enum: ['yoco', 'wizard'],
      required: true,
    },
    columnMapping: { type: columnMappingSchema, default: {} },
    itemsMode: {
      type: String,
      enum: ['packed', 'line-per-row'],
      default: 'packed',
    },
    status: {
      type: String,
      enum: ['pending_mapping', 'parsing', 'completed', 'failed', 'deleted'],
      default: 'pending_mapping',
      index: true,
    },
    stats: {
      imported: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
      totalRows: { type: Number, default: 0 },
    },
    dateRange: {
      firstDate: { type: Date },
      lastDate: { type: Date },
      firstDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
      lastDateKey: { type: String, match: /^\d{4}-\d{2}-\d{2}$/ },
    },
    errorMessage: { type: String },
    rowErrors: { type: [rowErrorSchema], default: [] },
    headers: [{ type: String }],
    sampleRows: [{ type: mongoose.Schema.Types.Mixed }],
    completedAt: { type: Date },
    confirmation: {
      mappingHash: { type: String },
      idempotencyKeyHash: { type: String },
      replayCount: { type: Number, default: 0 },
    },
    maintenance: {
      status: {
        type: String,
        enum: ['not_started', 'queued', 'running', 'completed', 'partial_failure'],
        default: 'not_started',
      },
      attempts: { type: Number, default: 0, min: 0 },
      startedAt: { type: Date },
      completedAt: { type: Date },
      nextRetryAt: { type: Date },
      retryExhaustedAt: { type: Date },
      errors: [{ type: String }],
    },
  },
  { timestamps: true }
);

uploadSchema.index({ cafeId: 1, createdAt: -1 });
uploadSchema.index({ cafeId: 1, fileFingerprint: 1, createdAt: -1 });

module.exports = mongoose.model('Upload', uploadSchema);
