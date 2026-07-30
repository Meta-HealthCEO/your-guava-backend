const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    password: {
      type: String,
      required: true,
      minlength: 8,
      select: false,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    role: {
      type: String,
      enum: ['owner', 'manager'],
      default: 'owner',
    },
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
    },
    cafeIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cafe',
      },
    ],
    activeCafeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cafe',
    },
    refreshTokens: {
      type: [
        {
        // `token` is retained temporarily so a token issued before the
        // production hardening release can be consumed once and rotated.
        // New sessions only persist a SHA-256 digest.
          token: { type: String },
          tokenHash: { type: String },
          expiresAt: { type: Date },
          createdAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
      select: false,
    },
    tokenVersion: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

userSchema.index({ orgId: 1 });
userSchema.index({ 'refreshTokens.tokenHash': 1 }, { sparse: true });
userSchema.index({ 'refreshTokens.token': 1 }, { sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return Boolean(this.password) && bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
