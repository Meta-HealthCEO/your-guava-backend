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

module.exports = { globalLimiter, authLimiter, refreshLimiter };
