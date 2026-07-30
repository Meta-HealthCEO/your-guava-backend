const mongoose = require('mongoose');

const accessAuditEventSchema = new mongoose.Schema(
  {
    orgId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    actorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    action: {
      type: String,
      required: true,
      enum: [
        'invitation.created',
        'invitation.resent',
        'invitation.revoked',
        'invitation.accepted',
        'member.updated',
        'member.removed',
        'ownership.transferred',
        'location.created',
        'password.changed',
        'password.reset',
      ],
      index: true,
    },
    targetEmail: { type: String, lowercase: true, trim: true, maxlength: 254 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    requestId: { type: String, maxlength: 128 },
  },
  { timestamps: true }
);

accessAuditEventSchema.index({ orgId: 1, createdAt: -1 });

module.exports = mongoose.model('AccessAuditEvent', accessAuditEventSchema);
