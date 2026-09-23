const { listAccessAudit } = require('./team/audit');
const { listTeam, removeMember, updateMemberCafes, updateMember } = require('./team/members');
const { inviteManager, previewInvitation, acceptInvitation, resendInvitation, revokeInvitation } = require('./team/invitations');
const { transferOwnership } = require('./team/ownership');
const { switchCafe, addCafe, archiveCafe, restoreCafe } = require('./team/cafes');

module.exports = {
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
  archiveCafe,
  restoreCafe,
};
