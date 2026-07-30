const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const trustedOrigin = require('../middleware/trustedOrigin.middleware');
const { authLimiter, refreshLimiter } = require('../middleware/rateLimit.middleware');
const {
  register,
  resendVerification,
  verifyEmail,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  me,
} = require('../controllers/auth.controller');

router.post('/register', trustedOrigin, authLimiter, register);
router.post('/resend-verification', trustedOrigin, authLimiter, resendVerification);
router.post('/verify-email', trustedOrigin, authLimiter, verifyEmail);
router.post('/login', trustedOrigin, authLimiter, login);
router.post('/refresh', trustedOrigin, refreshLimiter, refresh);
router.post('/logout', trustedOrigin, logout);
router.post('/forgot-password', trustedOrigin, authLimiter, forgotPassword);
router.post('/reset-password', trustedOrigin, authLimiter, resetPassword);
router.post('/change-password', authMiddleware, authLimiter, changePassword);
router.get('/me', authMiddleware, me);

module.exports = router;
