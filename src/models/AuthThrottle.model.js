const mongoose = require('mongoose');

/**
 * Durable counters for the per-account and per-recipient auth throttles (BE-02-T03). The key is `<bucket>:<sha256(email)>`,
 * so no address is stored in clear. D-005: one instance and no Redis, so state that must survive a restart lives in Mongo;
 * the TTL index removes each counter once it can no longer matter.
 */
const authThrottleSchema = new mongoose.Schema(
  {
    _id: { type: String },
    bucket: { type: String, required: true, maxlength: 40 },
    count: { type: Number, default: 0, min: 0 },
    windowStartedAt: { type: Date, required: true },
    blockedUntil: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

authThrottleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('AuthThrottle', authThrottleSchema);
