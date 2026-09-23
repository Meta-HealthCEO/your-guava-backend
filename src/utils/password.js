const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;
// bcrypt reads only the first 72 bytes; anything longer is refused rather than silently truncated.
const MAX_PASSWORD_BYTES = 72;
const DEFAULT_BCRYPT_ROUNDS = 12;
const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

const passwordTooLong = (value) => Buffer.byteLength(String(value), 'utf8') > MAX_PASSWORD_BYTES;

/**
 * The one password-input rule (identity-12). Returns a message for the client, or null when the value may reach bcrypt.
 * Only a non-empty string ever passes, so bcrypt can never throw "Illegal arguments" into a 500.
 */
const passwordInputError = (value, { label = 'Password', enforceMinimum = true } = {}) => {
  if (typeof value !== 'string' || value.length === 0) return `${label} is required`;
  if (passwordTooLong(value)) return `${label} cannot exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`;
  if (enforceMinimum && value.length < MIN_PASSWORD_LENGTH) {
    return `${label} must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
};

/** The one bcrypt cost (identity-13). BCRYPT_ROUNDS may lower it for tests; validateEnv refuses below 10 outside dev and test. */
const bcryptRounds = () => {
  const configured = Number.parseInt(process.env.BCRYPT_ROUNDS, 10);
  return Number.isInteger(configured) && configured >= 4 && configured <= 15 ? configured : DEFAULT_BCRYPT_ROUNDS;
};

/** The only bcrypt.hash call in src. */
const hashPassword = (plain) => bcrypt.hash(plain, bcryptRounds());

let dummyHashPromise = null;
/** A real hash of a random secret, so a login for an unknown address costs one bcrypt compare like a known one (identity-4). */
const dummyPasswordHash = () => {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword(crypto.randomBytes(24).toString('base64url'));
  }
  return dummyHashPromise;
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  DEFAULT_BCRYPT_ROUNDS,
  BCRYPT_HASH_RE,
  passwordTooLong,
  passwordInputError,
  bcryptRounds,
  hashPassword,
  dummyPasswordHash,
};
