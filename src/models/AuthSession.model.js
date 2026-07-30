const mongoose = require('mongoose');

const authSessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    familyId: {
      type: String,
      required: true,
      unique: true,
    },
    currentTokenHash: {
      type: String,
      required: true,
      select: false,
    },
    previousTokenHash: {
      type: String,
      select: false,
    },
    previousValidUntil: Date,
    graceTokenId: {
      type: String,
      select: false,
    },
    graceTokenIssuedAt: {
      type: Number,
      select: false,
    },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },
    revokedAt: Date,
    revokeReason: { type: String, maxlength: 120 },
  },
  { timestamps: true }
);

authSessionSchema.index({ userId: 1, revokedAt: 1, createdAt: -1 });
authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AuthSession', authSessionSchema);
