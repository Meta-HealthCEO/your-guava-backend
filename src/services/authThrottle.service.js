const { sha256Hex } = require('../utils/authPrimitives');
const AuthThrottle = require('../models/AuthThrottle.model');

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BASE_BACKOFF_MS = 60 * 1000;
const LOGIN_MAX_BACKOFF_MS = 15 * 60 * 1000;
const RECIPIENT_EMAIL_LIMIT = 3;
const RECIPIENT_WINDOW_MS = 60 * 60 * 1000;
const RECIPIENT_PURPOSES = new Set(['password_reset', 'signup']);

const keyFor = (bucket, email) =>
  `${bucket}:${sha256Hex(String(email).toLowerCase().trim())}`;

/**
 * Counts one event atomically in a fixed window that opens at the first event. With `block`, the count becomes a
 * blockedUntil: limit reached -> baseMs, doubling for each further event, never more than maxMs. One round trip; the
 * pipeline update is sent through the driver so Mongoose does not try to cast it.
 */
const countEvent = ({ bucket, email, windowMs, now, block }) => {
  const windowFloor = new Date(now.getTime() - windowMs);
  const freshWindow = { $or: [{ $not: ['$windowStartedAt'] }, { $lt: ['$windowStartedAt', windowFloor] }] };
  const backoffMs = block
    ? { $min: [block.maxMs, { $multiply: [block.baseMs, { $pow: [2, { $subtract: ['$count', block.limit] }] }] }] }
    : null;
  return AuthThrottle.collection.findOneAndUpdate(
    { _id: keyFor(bucket, email) },
    [
      {
        $set: {
          bucket,
          count: { $cond: [freshWindow, 1, { $add: ['$count', 1] }] },
          windowStartedAt: { $cond: [freshWindow, now, '$windowStartedAt'] },
        },
      },
      {
        $set: {
          blockedUntil: block ? { $cond: [{ $gte: ['$count', block.limit] }, { $add: [now, backoffMs] }, null] } : null,
          expiresAt: new Date(now.getTime() + windowMs + (block ? block.maxMs : 0)),
        },
      },
    ],
    { upsert: true, returnDocument: 'after' }
  );
};

const loginGate = async (email, now = new Date()) => {
  const record = await AuthThrottle.findById(keyFor('login', email)).select('blockedUntil').lean();
  if (record?.blockedUntil && record.blockedUntil > now) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((record.blockedUntil - now) / 1000)) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
};

const recordLoginFailure = (email, now = new Date()) => countEvent({
  bucket: 'login',
  email,
  windowMs: LOGIN_WINDOW_MS,
  now,
  block: { limit: LOGIN_FAILURE_LIMIT, baseMs: LOGIN_BASE_BACKOFF_MS, maxMs: LOGIN_MAX_BACKOFF_MS },
});

const clearLoginFailures = (email) => AuthThrottle.deleteOne({ _id: keyFor('login', email) });

/** One outbound email to `email` for `purpose`. Callers skip the send, silently, when `allowed` is false. */
const consumeRecipientQuota = async (purpose, email, now = new Date()) => {
  if (!RECIPIENT_PURPOSES.has(purpose)) throw new Error(`Unknown recipient purpose: ${purpose}`);
  const record = await countEvent({ bucket: `email_${purpose}`, email, windowMs: RECIPIENT_WINDOW_MS, now, block: null });
  return { allowed: record.count <= RECIPIENT_EMAIL_LIMIT, count: record.count };
};

module.exports = {
  LOGIN_FAILURE_LIMIT,
  LOGIN_WINDOW_MS,
  LOGIN_BASE_BACKOFF_MS,
  LOGIN_MAX_BACKOFF_MS,
  RECIPIENT_EMAIL_LIMIT,
  RECIPIENT_WINDOW_MS,
  loginGate,
  recordLoginFailure,
  clearLoginFailures,
  consumeRecipientQuota,
};
