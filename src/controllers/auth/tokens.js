// Token primitives: action and refresh tokens, access tokens, session pruning and issue (BE-11-T05 moves the generic ones to utils).
// Moved from auth.controller.js by BE-11-T04; behaviour unchanged.
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AuthSession = require('../../models/AuthSession.model');
const { resolveSessionCafeId } = require('../../utils/sessionCafe');
const { REFRESH_COOKIE_MAX_AGE_MS } = require('../../config/posture');

// Max active refresh-token families per user (roughly one per device).
const MAX_REFRESH_TOKENS = 10;
const ACTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const generateActionToken = () => crypto.randomBytes(32).toString('base64url');
const hashActionToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const normalizedActionToken = (value) => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return ACTION_TOKEN_RE.test(token) ? token : null;
};

const refreshTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + REFRESH_COOKIE_MAX_AGE_MS);
};

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
    currentTokenHash: hashRefreshToken(refreshToken),
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
  ACTION_TOKEN_RE, hashRefreshToken, generateActionToken, hashActionToken, normalizedActionToken, refreshTokenExpiry,
  generateAccessToken, generateRefreshToken, pruneAuthSessions, issueSession,
};
