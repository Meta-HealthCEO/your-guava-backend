const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { authLimiter, refreshLimiter } = require('../middleware/rateLimit.middleware');
const { register, login, refresh, logout, changePassword, me } = require('../controllers/auth.controller');

router.post('/register', authLimiter, register);
router.post('/login', authLimiter, login);
router.post('/refresh', refreshLimiter, refresh);
router.post('/logout', logout);
router.post('/change-password', authMiddleware, authLimiter, changePassword);
router.get('/me', authMiddleware, me);

module.exports = router;
