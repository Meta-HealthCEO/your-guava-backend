const { activeCafeId, scoped } = require('../../src/utils/tenancy');

describe('utils/tenancy (BE-11-T05)', () => {
  it('reads the active cafe from the authenticated request', () => {
    expect(activeCafeId({ user: { cafeId: 'cafe-1' } })).toBe('cafe-1');
  });

  it('answers null, and never throws, when there is no user or no cafe', () => {
    expect(activeCafeId({})).toBeNull();
    expect(activeCafeId({ user: {} })).toBeNull();
    expect(activeCafeId(undefined)).toBeNull();
  });

  it('scopes a filter to the active cafe, and a cafeId in the extra fields cannot widen it', () => {
    expect(scoped({ user: { cafeId: 'cafe-1' } }, { status: 'approved', cafeId: 'cafe-2' }))
      .toEqual({ status: 'approved', cafeId: 'cafe-1' });
  });
});
