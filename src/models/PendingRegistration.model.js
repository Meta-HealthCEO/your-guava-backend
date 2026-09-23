const mongoose = require('mongoose');

const pendingRegistrationSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    cafeName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    orgName: { type: String, required: true, trim: true, minlength: 2, maxlength: 120 },
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    // Rotations left for this submission (BE-02-T01); a new register resets it.
    resendCount: { type: Number, default: 0, min: 0 },
    // Wrong passwords at the verify step; the 5th deletes the record (BE-02-T01).
    verifyAttempts: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

pendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PendingRegistration', pendingRegistrationSchema);
