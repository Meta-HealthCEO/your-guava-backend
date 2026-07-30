const mongoose = require('mongoose');

const passwordResetTokenSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    tokenHash: { type: String, required: true, unique: true, select: false },
    status: {
      type: String,
      enum: ['pending', 'accepting', 'used', 'revoked', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true }
);

passwordResetTokenSchema.index({ userId: 1, status: 1, expiresAt: 1 });
passwordResetTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PasswordResetToken', passwordResetTokenSchema);
