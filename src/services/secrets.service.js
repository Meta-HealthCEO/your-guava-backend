const crypto = require('crypto');

const ENC_PREFIX = 'enc:v1:';
const KEY_LENGTH = 32;
// scrypt cost for deriving a key from JWT_SECRET. N=2^16 is well above the
// interactive-login minimum; the result is cached so this runs once per process.
const SCRYPT_PARAMS = { N: 1 << 16, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
const SCRYPT_SALT = 'your-guava-token-encryption';

let cachedKey = null;
let cachedKeySource = null;

/**
 * Returns the 32-byte AES key used for encrypting stored secrets.
 * Prefers TOKEN_ENCRYPTION_KEY (hex or base64); otherwise derives a
 * stable key from JWT_SECRET so encryption works without extra config.
 */
const getKey = () => {
  const source = process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!source) {
    throw new Error('TOKEN_ENCRYPTION_KEY or JWT_SECRET must be set to encrypt secrets');
  }
  if (cachedKey && cachedKeySource === source) return cachedKey;

  if (process.env.TOKEN_ENCRYPTION_KEY) {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      cachedKey = Buffer.from(raw, 'hex');
    } else {
      const decoded = Buffer.from(raw, 'base64');
      if (decoded.length === KEY_LENGTH) {
        cachedKey = decoded;
      } else {
        cachedKey = crypto.scryptSync(raw, SCRYPT_SALT, KEY_LENGTH, SCRYPT_PARAMS);
      }
    }
  } else {
    cachedKey = crypto.scryptSync(source, SCRYPT_SALT, KEY_LENGTH, SCRYPT_PARAMS);
  }
  cachedKeySource = source;
  return cachedKey;
};

/**
 * Encrypts a secret string with AES-256-GCM.
 * Output format: enc:v1:<iv>:<authTag>:<ciphertext> (base64url parts).
 * Null/empty values pass through unchanged.
 */
const encryptSecret = (value) => {
  if (value == null || value === '') return value;
  const plaintext = String(value);
  if (plaintext.startsWith(ENC_PREFIX)) return plaintext; // already encrypted

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ciphertext.toString('base64url')}`;
};

/**
 * Decrypts a value produced by encryptSecret.
 * Plaintext (legacy, pre-encryption) values pass through unchanged so
 * existing stored tokens keep working; they are re-encrypted on next write.
 */
const decryptSecret = (value) => {
  if (value == null || value === '') return value;
  const stored = String(value);
  if (!stored.startsWith(ENC_PREFIX)) return stored;

  const [ivPart, tagPart, dataPart] = stored.slice(ENC_PREFIX.length).split(':');
  if (!ivPart || !tagPart || !dataPart) {
    throw new Error('Malformed encrypted secret');
  }

  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
};

const isEncrypted = (value) => typeof value === 'string' && value.startsWith(ENC_PREFIX);

module.exports = { encryptSecret, decryptSecret, isEncrypted };
