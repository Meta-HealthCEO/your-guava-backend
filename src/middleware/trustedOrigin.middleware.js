const { originChecksEnabled } = require('../config/flags');

const originOf = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
};

/**
 * Cookie-setting auth endpoints must not accept cross-site browser requests.
 * CORS controls who can read a response; it does not stop a forged POST from
 * reaching the server or setting/rotating a cookie.
 */
const trustedOrigin = (req, res, next) => {
  // On everywhere unless the switch is off (tests/env.js turns it off; hardened environments refuse that). A missing Origin is refused.
  if (!originChecksEnabled()) return next();

  const expected = originOf(process.env.CLIENT_URL);
  const received = originOf(req.get('origin'));
  if (!expected || received !== expected) {
    return res.status(403).json({
      success: false,
      message: 'Request origin is not allowed',
    });
  }

  return next();
};

module.exports = trustedOrigin;
