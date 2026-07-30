const mongoose = require('mongoose');

const teamInvitationSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    invitedByUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254,
      match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 120,
    },
    cafeIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cafe',
        required: true,
      },
    ],
    permissions: {
      canSpendCredits: { type: Boolean, default: false },
    },
    tokenHash: {
      type: String,
      required: true,
      select: false,
    },
    status: {
      type: String,
      enum: ['pending', 'accepting', 'accepted', 'revoked', 'expired'],
      default: 'pending',
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    acceptedAt: Date,
    revokedAt: Date,
  },
  { timestamps: true }
);

teamInvitationSchema.index({ tokenHash: 1 }, { unique: true });
teamInvitationSchema.index(
  { orgId: 1, email: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  }
);
teamInvitationSchema.index({ orgId: 1, status: 1, expiresAt: 1 });

module.exports = mongoose.model('TeamInvitation', teamInvitationSchema);
