const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { listCafes, getMe, updateMe } = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/list', listCafes);
router.get('/me', getMe);
// Name, location and trading hours are forecast inputs; editing them wipes
// future forecasts, so only the owner may do it.
router.put('/me', ownerOnly, updateMe);

module.exports = router;
