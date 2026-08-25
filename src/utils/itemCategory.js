/**
 * Infers a menu item's category from its name.
 *
 * This matters more than it looks: the category selects the weather factor. On
 * a cold day coffee is adjusted +15% and cold drinks -20%, while every other
 * category gets no temperature response. An item that falls through to "other"
 * therefore loses its weather signal silently.
 *
 * Order is deliberate. Merchandise is checked first but only on unambiguous
 * markers -- a bare "(Blend)" suffix is drink wording on most South African
 * menus, so it must not pull espresso drinks into retail. Cold drinks are
 * checked before hot ones so "Iced Coffee" and "Cold Brew" are not read as
 * coffee, and before food so "Lemonade" is not read as a lemon bake.
 *
 * A user can override the category in Menu Items, and re-ingesting never
 * overwrites a value they set -- see menuItems.service.
 */

const matchesAny = (haystack, needles) => needles.some((needle) => haystack.includes(needle));

// Some terms are substrings of unrelated words -- "chocolate" contains "cola" --
// so they are matched on a word boundary rather than anywhere in the name.
const WORD_MATCH = /(cola|ice|shake)/;
const matchesWord = (haystack) => WORD_MATCH.test(haystack);

// Packaged goods: a weight marker, whole beans, or non-consumable merchandise.
const RETAIL = [
  '250g', '500g', '750g', '1kg', 'beans', 'mug', 'tote', 'merch',
  't-shirt', 'tshirt', 'gift card', 'voucher', 'keep cup', 'reusable cup',
];

const WATER = ['still water', 'sparkling water', 'mineral water', 'water', 'still 500', 'still 750'];

const COLD_DRINK = [
  'iced', 'cold brew', 'frappe', 'frappé', 'lemonade', 'juice', 'smoothie',
  'milkshake', 'soda', 'coke', 'fanta', 'sprite', 'slush',
  'cooler', 'kombucha', 'ginger beer',
];

const COFFEE = [
  'coffee', 'espresso', 'latte', 'cappuccino', 'cortado', 'americano', 'macchiato',
  'piccolo', 'doppio', 'ristretto', 'babyccino', 'flat white', 'long white',
  'mocha', 'hot choc', 'hot chocolate', 'pour over', 'filter', 'drip', 'brew',
  'chai', 'matcha', 'rooibos', 'cortado', 'red espresso', 'black coffee',
];

const FOOD = [
  'muffin', 'croissant', 'brownie', 'cookie', 'cake', 'sandwich', 'wrap', 'roll',
  'toastie', 'toast', 'quiche', 'scone', 'salad', 'rusks', 'bagel', 'pie', 'tart',
  'bun', 'panini', 'burger', 'omelette', 'breakfast', 'granola', 'yoghurt',
  'crunch', 'lemon', 'banana', 'simple square', 'poppyseed', 'bread', 'waffle',
  'waffle', 'pancake', 'bowl',
];

const inferItemCategory = (name = '') => {
  const n = String(name || '').toLowerCase();
  if (!n.trim()) return 'other';

  if (matchesAny(n, RETAIL)) return 'retail';
  // "Watermelon" contains "water" but is a drink, not bottled water.
  if (!n.includes('watermelon') && matchesAny(n, WATER)) return 'water';
  if (matchesAny(n, COLD_DRINK) || matchesWord(n)) return 'cold_drink';
  if (matchesAny(n, COFFEE)) return 'coffee';
  if (matchesAny(n, FOOD)) return 'food';
  return 'other';
};

module.exports = { inferItemCategory };
