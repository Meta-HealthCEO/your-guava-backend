const { inferItemCategory } = require('../../src/utils/itemCategory');

describe('itemCategory', () => {
  it('infers forecast-relevant categories from item names', () => {
    expect(inferItemCategory('Flat White (Blend)')).toBe('coffee');
    expect(inferItemCategory('Iced Coffee')).toBe('cold_drink');
    expect(inferItemCategory('Still Water')).toBe('water');
    expect(inferItemCategory('Chocolate Brownie')).toBe('food');
    expect(inferItemCategory('House Blend 250g')).toBe('retail');
  });
});
