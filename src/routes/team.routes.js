const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const trustedOrigin = require('../middleware/trustedOrigin.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { inviteLimiter, writeLimiter } = require('../middleware/rateLimit.middleware');
const {
  inviteManager,
  previewInvitation,
  acceptInvitation,
  resendInvitation,
  revokeInvitation,
  listTeam,
  listAccessAudit,
  removeMember,
  updateMemberCafes,
  updateMember,
  transferOwnership,
  switchCafe,
  addCafe,
} = require('../controllers/team.controller');

// Capability tokens stay in POST bodies so URL and request logs never receive them.
router.post('/invitations/preview', trustedOrigin, inviteLimiter, previewInvitation);
router.post('/invitations/accept', trustedOrigin, inviteLimiter, acceptInvitation);

router.use(authMiddleware);

// Any authenticated user can switch cafe
router.post('/switch-cafe', switchCafe);

// Owner-only endpoints
router.get('/', ownerOnly, listTeam);
router.get('/audit-events', ownerOnly, listAccessAudit);
router.post('/invite', ownerOnly, writeLimiter, inviteManager);
router.post('/invitations/:invitationId/resend', ownerOnly, writeLimiter, resendInvitation);
router.delete('/invitations/:invitationId', ownerOnly, writeLimiter, revokeInvitation);
router.delete('/:userId', ownerOnly, removeMember);
router.patch('/:userId', ownerOnly, updateMember);
router.put('/:userId/cafes', ownerOnly, updateMemberCafes);
router.post('/transfer-ownership', ownerOnly, writeLimiter, transferOwnership);
router.post('/add-cafe', ownerOnly, addCafe);

module.exports = router;
