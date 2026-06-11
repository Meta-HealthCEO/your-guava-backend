process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345';

const { encryptSecret, decryptSecret, isEncrypted } = require('../../src/services/secrets.service');

describe('secrets service', () => {
  it('round-trips a secret', () => {
    const encrypted = encryptSecret('super-secret-oauth-token');
    expect(encrypted).toMatch(/^enc:v1:/);
    expect(encrypted).not.toContain('super-secret-oauth-token');
    expect(decryptSecret(encrypted)).toBe('super-secret-oauth-token');
  });

  it('produces a different ciphertext per call (random IV)', () => {
    const a = encryptSecret('same-value');
    const b = encryptSecret('same-value');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same-value');
    expect(decryptSecret(b)).toBe('same-value');
  });

  it('passes legacy plaintext values through decrypt unchanged', () => {
    expect(decryptSecret('legacy-plaintext-token')).toBe('legacy-plaintext-token');
  });

  it('passes null/empty values through both directions', () => {
    expect(encryptSecret(null)).toBeNull();
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret(null)).toBeNull();
    expect(decryptSecret(undefined)).toBeUndefined();
  });

  it('does not double-encrypt already encrypted values', () => {
    const once = encryptSecret('value');
    const twice = encryptSecret(once);
    expect(twice).toBe(once);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptSecret('value');
    const tampered = encrypted.slice(0, -2) + 'zz';
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it('identifies encrypted values', () => {
    expect(isEncrypted(encryptSecret('x'))).toBe(true);
    expect(isEncrypted('plain')).toBe(false);
  });
});
