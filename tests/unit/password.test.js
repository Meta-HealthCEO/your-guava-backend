const bcrypt = require('bcryptjs');
const {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  passwordTooLong,
  passwordInputError,
  dummyPasswordHash,
} = require('../../src/utils/password');

describe('password input rules', () => {
  it('rejects anything that is not a non-empty string before it can reach bcrypt', () => {
    for (const value of [undefined, null, '', 12345678, true, {}, { $gt: '' }, ['password123']]) {
      expect(passwordInputError(value)).toBe('Password is required');
    }
  });

  it('states both bounds with the caller label', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(MAX_PASSWORD_BYTES).toBe(72);
    expect(passwordInputError('short7', { label: 'New password' })).toBe('New password must be at least 8 characters');
    expect(passwordInputError('é'.repeat(37))).toBe('Password cannot exceed 72 UTF-8 bytes');
    expect(passwordInputError('short7', { enforceMinimum: false })).toBeNull();
    expect(passwordInputError('password123')).toBeNull();
  });

  it('measures length in UTF-8 bytes, not characters', () => {
    expect(passwordTooLong('a'.repeat(72))).toBe(false);
    expect(passwordTooLong('a'.repeat(73))).toBe(true);
    expect(passwordTooLong('é'.repeat(37))).toBe(true);
  });

  it('builds one real bcrypt hash for unknown-account comparisons and reuses it', async () => {
    const first = await dummyPasswordHash();
    const second = await dummyPasswordHash();
    expect(first).toBe(second);
    expect(first).toMatch(/^\$2[aby]\$\d{2}\$/);
    await expect(bcrypt.compare('password123', first)).resolves.toBe(false);
  });
});
