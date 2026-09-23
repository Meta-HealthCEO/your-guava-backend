const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const trustedOrigin = require('../middleware/trustedOrigin.middleware');
const { authLimiters, refreshLimiter } = require('../middleware/rateLimit.middleware');
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

router.post('/register', trustedOrigin, authLimiters.register, register);
router.post('/resend-verification', trustedOrigin, authLimiters.verification, resendVerification);
router.post('/verify-email', trustedOrigin, authLimiters.verification, verifyEmail);
router.post('/login', trustedOrigin, authLimiters.login, login);
router.post('/refresh', trustedOrigin, refreshLimiter, refresh);
router.post('/logout', trustedOrigin, logout);
router.post('/forgot-password', trustedOrigin, authLimiters.passwordReset, forgotPassword);
router.post('/reset-password', trustedOrigin, authLimiters.passwordReset, resetPassword);
router.post('/change-password', authMiddleware, authLimiters.changePassword, changePassword);
router.get('/me', authMiddleware, me);

module.exports = router;
