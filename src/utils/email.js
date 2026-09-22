/**
 * The one email check every caller uses.
 *
 * Until 22 Sep 2026 seven files carried their own copy of one anchored
 * local@domain pattern whose domain part, [^\s@]+\.[^\s@]+, could split at
 * any dot, so a long dotted string made the engine try every split: 1.4 s for 40,000
 * characters, and 14-18 s for the 99 KB body a login accepts, with the event
 * loop blocked for every cafe. Login needs no account, so any stranger could
 * do it. Callers also checked the length, but after the regex, not before.
 *
 * This accepts exactly what that pattern accepted (stored users are
 * re-validated on every save, so nothing that passed before may fail now),
 * except anything longer than an address can be, and it does it in one pass
 * with no backtracking.
 */
const EMAIL_MAX_LENGTH = 254;

const WHITESPACE = /\s/;

const isValidEmail = (value) => {
  if (typeof value !== 'string' || value.length > EMAIL_MAX_LENGTH) return false;
  const at = value.indexOf('@');
  // A local part of at least one character, and exactly one "@".
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  if (WHITESPACE.test(value)) return false;
  // At least one dot with a character on each side of it.
  return value.slice(at + 2, -1).includes('.');
};

module.exports = { EMAIL_MAX_LENGTH, isValidEmail };
