const { isRelaxedEnvironment, isHardenedEnvironment, refreshCookieOptions } = require('../../src/config/posture');

describe('environment posture', () => {
  const original = process.env.NODE_ENV;
  afterEach(() => { process.env.NODE_ENV = original; });

  it.each([
    ['test', true, true],
    ['development', false, true],
    ['staging', false, false],
    ['preview', false, false],
    ['production', false, false],
    ['', false, false],
  ])('NODE_ENV=%p: test=%p relaxed=%p', (value, test, relaxed) => {
    process.env.NODE_ENV = value;
    expect(isRelaxedEnvironment()).toBe(relaxed);
    expect(isHardenedEnvironment()).toBe(!relaxed);
  });

  it('sets secure, cross-site refresh cookies in every hardened environment', () => {
    process.env.NODE_ENV = 'staging';
    expect(refreshCookieOptions()).toEqual({
      httpOnly: true, sameSite: 'none', secure: true, path: '/api/auth', maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    expect(refreshCookieOptions({ clearing: true })).toEqual({ httpOnly: true, sameSite: 'none', secure: true, path: '/api/auth' });
    process.env.NODE_ENV = 'development';
    expect(refreshCookieOptions()).toEqual(expect.objectContaining({ sameSite: 'lax', secure: false }));
  });
});
