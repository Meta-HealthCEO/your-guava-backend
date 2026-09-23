const jwt = require('jsonwebtoken');
const {
  OPAQUE_TOKEN_RE, generateOpaqueToken, normalizedOpaqueToken, sha256Hex, setRefreshCookie, clearRefreshCookie, generateAccessToken,
} = require('../../src/utils/authPrimitives');

describe('utils/authPrimitives (BE-11-T05)', () => {
  beforeAll(() => { process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-key-12345'; });

  it('mints the one access-token claim set', () => {
    const token = generateAccessToken('user-1', '507f1f77bcf86cd799439011', 'manager', '507f1f77bcf86cd799439012', 3);
    expect(jwt.verify(token, process.env.JWT_SECRET)).toEqual(expect.objectContaining({
      id: 'user-1', cafeId: '507f1f77bcf86cd799439011', role: 'manager', orgId: '507f1f77bcf86cd799439012', tokenVersion: 3,
    }));
  });

  it('generates 43-character url-safe tokens and accepts only that shape back', () => {
    const token = generateOpaqueToken();
    expect(token).toMatch(OPAQUE_TOKEN_RE);
    expect(normalizedOpaqueToken(` ${token} `)).toBe(token);
    expect(normalizedOpaqueToken('short')).toBeNull();
    expect(normalizedOpaqueToken({ $ne: null })).toBeNull();
  });

  it('hashes tokens to SHA-256 hex, as the three old hashers did', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('sets and clears the refresh cookie with one name, one path and one set of flags', () => {
    const res = { cookie: jest.fn(), clearCookie: jest.fn() };
    setRefreshCookie(res, 'token-value');
    clearRefreshCookie(res);
    // NODE_ENV is 'test' (tests/env.js): relaxed flags, as login and logout sent them before the move.
    expect(res.cookie).toHaveBeenCalledWith('refreshToken', 'token-value', {
      httpOnly: true, sameSite: 'lax', secure: false, path: '/api/auth', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    expect(res.clearCookie).toHaveBeenCalledWith('refreshToken', {
      httpOnly: true, sameSite: 'lax', secure: false, path: '/api/auth',
    });
  });
});
