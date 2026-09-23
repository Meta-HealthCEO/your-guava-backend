// Session tokens: refresh-token minting and expiry, session pruning and issue.
// The generic primitives (opaque tokens, hashing, access tokens, the cookie) live in utils/authPrimitives.js (BE-11-T05).
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AuthSession = require('../../models/AuthSession.model');
const { resolveSessionCafeId } = require('../../utils/sessionCafe');
const { REFRESH_COOKIE_MAX_AGE_MS } = require('../../config/posture');
const { sha256Hex, generateAccessToken } = require('../../utils/authPrimitives');

// Max active refresh-token families per user (roughly one per device).
const MAX_REFRESH_TOKENS = 10;
const refreshTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS);
};

const generateRefreshToken = (
  userId,
  familyId,
  {
    tokenId = crypto.randomUUID(),
    issuedAt = Math.floor(Date.now() / 1000),
    expiresAt,
  } = {}
) => {
  const payload = {
    id: userId,
    sid: familyId,
    jti: tokenId,
    iat: issuedAt,
    ...(Number.isFinite(expiresAt) ? { exp: expiresAt } : {}),
  };
  return jwt.sign(
    payload,
    process.env.JWT_REFRESH_SECRET,
    Number.isFinite(expiresAt)
      ? {}
      : { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
};

const pruneAuthSessions = async (userId) => {
  const stale = await AuthSession.find({ userId, revokedAt: null })
    .sort({ createdAt: -1, _id: -1 })
    .skip(MAX_REFRESH_TOKENS)
    .select('_id')
    .lean();
  if (stale.length > 0) {
    await AuthSession.updateMany(
      { _id: { $in: stale.map((entry) => entry._id) }, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: 'session_limit' } }
    );
  }
};

const issueSession = async (user, { cafeId: requestedCafeId } = {}) => {
  const familyId = crypto.randomUUID();
  const refreshToken = generateRefreshToken(user._id, familyId);
  await AuthSession.create({
    userId: user._id,
    familyId,
    currentTokenHash: sha256Hex(refreshToken),
    expiresAt: refreshTokenExpiry(refreshToken),
  });
  await pruneAuthSessions(user._id);

  const cafeId = resolveSessionCafeId(user, requestedCafeId);
  return {
    accessToken: generateAccessToken(user._id, cafeId, user.role, user.orgId, user.tokenVersion),
    refreshToken,
    cafeId,
  };
};

module.exports = {
  refreshTokenExpiry, generateRefreshToken, pruneAuthSessions, issueSession,
};
