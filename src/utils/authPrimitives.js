const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { refreshCookieOptions } = require('../config/posture');

/**
 * The auth building blocks every controller shares (BE-11-T05). Before this, access
 * tokens were minted in two places that had drifted (switchCafe did not default the
 * role or stringify the cafe), and the token hasher, token shape and refresh-cookie
 * calls were copied three or four times each. Password rules live in utils/password.js;
 * the cookie flags live in config/posture.js (BE-02-T06), which these helpers call.
 */
const OPAQUE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Email verification, password reset and team invitations all use this shape.
const generateOpaqueToken = () => crypto.randomBytes(32).toString('base64url');

const normalizedOpaqueToken = (value) => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return OPAQUE_TOKEN_RE.test(token) ? token : null;
};

// Stored tokens and confirmation keys are SHA-256 digests of the raw value.
const sha256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

// The refresh token travels in one httpOnly cookie, scoped to /api/auth.
const REFRESH_COOKIE_NAME = 'refreshToken';

const setRefreshCookie = (res, token) => res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());

const clearRefreshCookie = (res) => res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions({ clearing: true }));

const generateAccessToken = (userId, cafeId, role, orgId, tokenVersion = 0) =>
  jwt.sign(
    {
      id: userId,
      cafeId: cafeId ? cafeId.toString() : null,
      role: role || 'owner',
      orgId: orgId ? orgId.toString() : null,
      tokenVersion: Number(tokenVersion || 0),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

module.exports = {
  OPAQUE_TOKEN_RE,
  generateOpaqueToken,
  normalizedOpaqueToken,
  sha256Hex,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  clearRefreshCookie,
  generateAccessToken,
};
