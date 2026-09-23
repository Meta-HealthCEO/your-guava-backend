const { resolveSessionCafeId } = require('../../src/utils/sessionCafe');

const A = '0123456789abcdef01234567';
const B = '89abcdef0123456789abcdef';
const user = (cafeIds, activeCafeId) => ({ cafeIds, activeCafeId });

describe('resolveSessionCafeId', () => {
  it('grants the cafe the tab asked for when the user can open it', () => {
    expect(resolveSessionCafeId(user([A, B], A), B)).toBe(B);
    expect(resolveSessionCafeId(user([A, B], A), B.toUpperCase())).toBe(B);
  });

  it('falls back to the default, then the first cafe, then null', () => {
    expect(resolveSessionCafeId(user([A, B], B), undefined)).toBe(B);
    expect(resolveSessionCafeId(user([A, B], 'ffffffffffffffffffffffff'), undefined)).toBe(A);
    expect(resolveSessionCafeId(user([], null), A)).toBeNull();
  });

  it('ignores anything that is not a 24-hex id the user owns', () => {
    for (const requested of [{ $ne: null }, [A], 'aaaaaaaaaaaa', `${A} `, '', 42, null]) {
      expect(resolveSessionCafeId(user([A, B], A), requested)).toBe(A);
    }
    expect(resolveSessionCafeId(user([A], A), B)).toBe(A);
  });
});
