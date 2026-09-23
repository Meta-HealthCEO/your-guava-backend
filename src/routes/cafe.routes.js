const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { listCafes, getMe, updateMe } = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/list', listCafes);
router.get('/me', getMe);
// Owner-only: configuration and destructive re-processing (tests/fixtures/rbacTable.js states the whole policy).
router.put('/me', ownerOnly, updateMe);

module.exports = router;
