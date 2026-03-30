const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { listCafes, getMe, updateMe } = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/list', listCafes);
router.get('/me', getMe);
router.put('/me', updateMe);

module.exports = router;
