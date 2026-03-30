const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { getMe, updateMe } = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/me', getMe);
router.put('/me', updateMe);

module.exports = router;
