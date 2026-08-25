const { inferItemCategory } = require('../../src/utils/itemCategory');

/**
 * The category drives the weather factor: on a cold day coffee gets +15% and
 * cold drinks -20%, while every other category gets no temperature response at
 * all. A misfiled item therefore silently loses its weather adjustment, so this
 * classifier is worth holding to a real menu rather than one cafe's wording.
 */
describe('inferItemCategory', () => {
  const expectCategory = (cases, expected) =>
    cases.forEach((name) =>
      it(`classifies "${name}" as ${expected}`, () =>
        expect(inferItemCategory(name)).toBe(expected))
    );

  describe('coffee and hot drinks', () => {
    expectCategory(
      [
        'Flat White (Blend)', 'Long White (Blend)', 'Cappuccino', 'Cortado (Blend)',
        'Americano', 'Espresso', 'Doppio', 'Ristretto', 'Macchiato', 'Piccolo',
        'Babyccino', 'House Coffee (Blend)', 'Filter Coffee', 'Coffee of the Day',
        'Drip Coffee', 'Batch Brew', 'Mocha', 'Hot Chocolate', 'Rooibos Latte',
        'Chai Latte', 'Matcha Latte (Hot)', 'Pour Over',
      ],
      'coffee'
    );
  });

  describe('cold drinks', () => {
    expectCategory(
      [
        'Iced Coffee', 'Iced Latte', 'Cold Brew', 'Iced Tea', 'Lemonade',
        'Fresh Orange Juice', 'Smoothie - Berry', 'Milkshake Vanilla',
        'Coke', 'Fanta Orange', 'Sprite', 'Frappe',
      ],
      'cold_drink'
    );
  });

  describe('water', () => {
    expectCategory(['Still Water 500ml', 'Sparkling Water', 'Still 750ml'], 'water');
  });

  describe('food', () => {
    expectCategory(
      [
        'Blueberry Muffin', 'Butter Croissant', 'Brownie', 'Chocolate Cookie',
        'Carrot Cake', 'Chicken Sandwich', 'Chicken Wrap', 'Bacon & Egg Roll',
        'Toastie', 'Quiche', 'Scone', 'Salad Bowl', 'Rusks', 'Lemon Poppyseed',
        'Banana Bread', 'Bagel',
      ],
      'food'
    );
  });

  describe('retail merchandise', () => {
    // Retail needs an unambiguous marker. "Blend" alone is a drink suffix on
    // most menus, so it must not pull espresso drinks into merchandise.
    expectCategory(
      ['Beans 250g', 'House Blend 1kg', 'Espresso Blend 750g', 'Guava Mug', 'Tote Bag'],
      'retail'
    );
  });

  describe('edge cases', () => {
    it('does not treat a bare "(Blend)" suffix as merchandise', () => {
      expect(inferItemCategory('Flat White (Blend)')).toBe('coffee');
    });

    it('separates lemonade from lemon bakery items', () => {
      expect(inferItemCategory('Lemonade')).toBe('cold_drink');
      expect(inferItemCategory('Lemon Poppyseed')).toBe('food');
    });

    it('treats iced coffee as a cold drink, not a hot one', () => {
      expect(inferItemCategory('Iced Coffee')).toBe('cold_drink');
    });

    it('does not mistake watermelon for bottled water', () => {
      expect(inferItemCategory('Watermelon Cooler')).toBe('cold_drink');
    });

    it('falls back to other for genuinely unknown items', () => {
      expect(inferItemCategory('Mystery Item')).toBe('other');
      expect(inferItemCategory('')).toBe('other');
      expect(inferItemCategory()).toBe('other');
    });
  });
});
