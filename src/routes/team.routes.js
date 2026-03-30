const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  inviteManager,
  listTeam,
  removeMember,
  updateMemberCafes,
  switchCafe,
  addCafe,
} = require('../controllers/team.controller');

router.use(authMiddleware);

// Any authenticated user can switch cafe
router.post('/switch-cafe', switchCafe);

// Owner-only endpoints
router.get('/', ownerOnly, listTeam);
router.post('/invite', ownerOnly, inviteManager);
router.delete('/:userId', ownerOnly, removeMember);
router.put('/:userId/cafes', ownerOnly, updateMemberCafes);
router.post('/add-cafe', ownerOnly, addCafe);

module.exports = router;
