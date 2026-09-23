// The access audit: recording an event and listing them with the compound cursor.
// Moved from team.controller.js by BE-11-T03; behaviour unchanged.
const mongoose = require('mongoose');
const AccessAuditEvent = require('../../models/AccessAuditEvent.model');

const recordAccessAudit = async ({
  orgId,
  actorUserId,
  targetUserId,
  action,
  targetEmail,
  details,
  requestId,
  session,
}) =>
  AccessAuditEvent.create([{
    orgId,
    actorUserId,
    targetUserId,
    action,
    targetEmail,
    details: details || {},
    requestId,
  }], session ? { session } : undefined);

// GET /api/team/audit-events - Durable owner-visible access history.
const listAccessAudit = async (req, res, next) => {
  try {
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));
    const filter = { orgId: req.user.orgId };
    if (req.query.before !== undefined) {
      const before = typeof req.query.before === 'string' ? new Date(req.query.before) : new Date(Number.NaN);
      if (Number.isNaN(before.getTime())) {
        return res.status(400).json({ success: false, message: 'before must be a valid date' });
      }
      const beforeId = req.query.beforeId;
      if (beforeId !== undefined && (typeof beforeId !== 'string' || !/^[a-f0-9]{24}$/i.test(beforeId))) {
        return res.status(400).json({ success: false, message: 'beforeId must be an event id' });
      }
      // identity-19: (createdAt, _id) is the sort key, so it is the cursor; events sharing a millisecond are not skipped.
      filter.$or = beforeId
        ? [{ createdAt: { $lt: before } }, { createdAt: before, _id: { $lt: new mongoose.Types.ObjectId(beforeId) } }]
        : [{ createdAt: { $lt: before } }];
    }

    const events = await AccessAuditEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit + 1)
      .populate('actorUserId', 'name email')
      .populate('targetUserId', 'name email')
      .lean();
    const hasMore = events.length > limit;
    if (hasMore) events.pop();

    const last = events.length > 0 ? events[events.length - 1] : null;
    return res.status(200).json({
      success: true,
      events,
      pagination: {
        hasMore,
        nextBefore: hasMore && last ? last.createdAt : null,
        nextBeforeId: hasMore && last ? String(last._id) : null,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  recordAccessAudit, listAccessAudit,
};
