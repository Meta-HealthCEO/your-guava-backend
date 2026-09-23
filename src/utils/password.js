const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const MIN_PASSWORD_LENGTH = 8;
// bcrypt reads only the first 72 bytes; anything longer is refused rather than silently truncated.
const MAX_PASSWORD_BYTES = 72;
const DUMMY_HASH_ROUNDS = 10; // BE-02-T07 replaces this with bcryptRounds() so the dummy costs what a real hash costs.

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

let dummyHashPromise = null;
/** A real hash of a random secret, so a login for an unknown address costs one bcrypt compare like a known one (identity-4). */
const dummyPasswordHash = () => {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(crypto.randomBytes(24).toString('base64url'), DUMMY_HASH_ROUNDS);
  }
  return dummyHashPromise;
};

module.exports = { MIN_PASSWORD_LENGTH, MAX_PASSWORD_BYTES, passwordTooLong, passwordInputError, dummyPasswordHash };
