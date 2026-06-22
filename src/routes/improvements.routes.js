const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { writeLimiter } = require('../middleware/rateLimit.middleware');
const {
  create,
  list,
  getOne,
  updateStatus,
  remove,
} = require('../controllers/improvements.controller');

router.use(authMiddleware);

// Any partner (owner or manager) can log and view improvements.
router.get('/', list);
router.post('/', writeLimiter, create);
router.get('/:id', getOne);

// Triage actions are owner-only.
router.patch('/:id/status', ownerOnly, updateStatus);
router.delete('/:id', ownerOnly, remove);

module.exports = router;
