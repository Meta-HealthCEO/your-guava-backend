const rateLimit = require('express-rate-limit');

const isTest = () => process.env.NODE_ENV === 'test';

// Loose global limiter — protects against runaway clients and basic scraping.
const globalLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  message: { success: false, message: 'Too many requests, please slow down' },
});

// Strict limiter for credential endpoints (login/register) — brute-force protection.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  message: { success: false, message: 'Too many attempts, please try again later' },
});

// Moderate limiter for token refresh — legitimately called on a timer by active
// sessions (~4/hr each), so more generous than login but still bounded per IP.
const refreshLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  message: { success: false, message: 'Too many refresh attempts, please try again later' },
});

// Public invitation tokens are high entropy, but preview/accept remain bounded
// to prevent endpoint enumeration and password-hash resource abuse.
const inviteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  message: { success: false, message: 'Too many invitation attempts, please try again later' },
});

// Per-user limiter for authenticated write actions (e.g. logging tickets),
// keyed by user id so one busy user can't exhaust a shared IP's budget.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  // Always runs after authMiddleware, so req.user.id is the real key; the IP
  // fallback is a safety net only, hence the IP-fallback validation is disabled.
  keyGenerator: (req) => req.user?.id || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: { success: false, message: 'You are doing that too quickly. Please slow down.' },
});

module.exports = { globalLimiter, authLimiter, refreshLimiter, inviteLimiter, writeLimiter };
