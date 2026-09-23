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

// One bucket per auth action (identity-14): staff sharing one address can mistype a password without locking out resets and
// signups, and each budget fits its action. Per-IP and in memory, which D-005 accepts; the per-account and per-recipient
// limits that must survive a restart live in services/authThrottle.service.js.
const AUTH_LIMITS = {
  login: { windowMs: 15 * 60 * 1000, limit: 20 },
  register: { windowMs: 60 * 60 * 1000, limit: 10 },
  passwordReset: { windowMs: 15 * 60 * 1000, limit: 10 },
  verification: { windowMs: 15 * 60 * 1000, limit: 20 },
  changePassword: { windowMs: 15 * 60 * 1000, limit: 10 },
};

const AUTH_LIMIT_MESSAGES = {
  login: 'Too many sign-in attempts from this network. Please wait 15 minutes.',
  register: 'Too many sign-ups from this network. Please wait an hour.',
  passwordReset: 'Too many password reset requests. Please wait 15 minutes.',
  verification: 'Too many verification attempts. Please wait 15 minutes.',
  changePassword: 'Too many password change attempts. Please wait 15 minutes.',
};

const createAuthLimiters = ({ skip = isTest, limits = {} } = {}) => {
  const build = (name, extra = {}) => {
    const config = { ...AUTH_LIMITS[name], ...(limits[name] || {}) };
    return rateLimit({
      windowMs: config.windowMs,
      limit: config.limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      skip,
      message: { success: false, code: 'AUTH_RATE_LIMITED', message: AUTH_LIMIT_MESSAGES[name] },
      ...extra,
    });
  };
  return {
    login: build('login'),
    register: build('register'),
    passwordReset: build('passwordReset'),
    verification: build('verification'),
    // Runs after authMiddleware, so the user id is the key (same pattern as writeLimiter).
    changePassword: build('changePassword', {
      keyGenerator: (req) => req.user?.id || req.ip,
      validate: { keyGeneratorIpFallback: false },
    }),
  };
};

const authLimiters = createAuthLimiters();

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

// Paid AI calls are expensive and can hold provider connections open. Bound them
// per organization and user independently of the broad IP-based global limiter.
const AI_LIMIT = 20;
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: AI_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: (req) => `${req.user?.orgId || 'unknown'}:${req.user?.id || req.ip}`,
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    code: 'AI_RATE_LIMITED',
    message: 'Too many AI requests. Please wait a moment and try again.',
  },
});

// Uploads need their own budget. Most uploads never touch the AI mapper -- a Yoco
// export is matched by preset and a returning cafe reuses its saved mapping -- so
// charging them against the AI budget cut an owner off mid-import while telling
// them they had made too many "AI requests", which is both wrong and unactionable.
// This exists to bound disk writes and parsing work, so it sits ahead of multer.
const UPLOAD_LIMIT = 40;
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: UPLOAD_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: (req) => req.user?.id || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    code: 'UPLOAD_RATE_LIMITED',
    message: 'That is a lot of files at once. Wait a minute, then continue importing.',
  },
});

// Confirm and remap parse a whole stored file every time, and a failed upload
// can be confirmed again, so a member could repeat the heaviest work the API
// does behind nothing but the loose global limiter (security-3).
const PARSE_LIMIT = 20;
const parseLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: PARSE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: isTest,
  keyGenerator: (req) => req.user?.id || req.ip,
  validate: { keyGeneratorIpFallback: false },
  message: {
    success: false,
    code: 'PARSE_RATE_LIMITED',
    message: 'That is a lot of imports at once. Wait a minute, then continue.',
  },
});

// Exposed so tests can assert the budgets stay in the right relationship to each
// other without reaching into express-rate-limit internals.
const getLimiterOptions = (name) => {
  if (name === 'ai') return { limit: AI_LIMIT, windowMs: 60 * 1000 };
  if (name === 'upload') return { limit: UPLOAD_LIMIT, windowMs: 60 * 1000 };
  if (name === 'parse') return { limit: PARSE_LIMIT, windowMs: 60 * 1000 };
  throw new Error(`Unknown limiter: ${name}`);
};

module.exports = {
  aiLimiter,
  uploadLimiter,
  parseLimiter,
  getLimiterOptions,
  globalLimiter,
  authLimiters,
  createAuthLimiters,
  AUTH_LIMITS,
  refreshLimiter,
  inviteLimiter,
  writeLimiter,
};
