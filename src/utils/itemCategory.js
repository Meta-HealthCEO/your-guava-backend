const inferItemCategory = (name = '') => {
  const n = String(name).toLowerCase();

  if (n.includes('still') || n.includes('sparkling') || n.includes('water')) return 'water';
  if (n.includes('iced') || n.includes('cold brew')) return 'cold_drink';
  if (n.includes('matcha') && n.includes('iced')) return 'cold_drink';
  if (
    n.includes('flat white') || n.includes('long white') || n.includes('cappuccino') ||
    n.includes('cortado') || n.includes('espresso') || n.includes('americano') ||
    n.includes('black coffee') || n.includes('mocha') || n.includes('hot choc') ||
    n.includes('latte') || n.includes('pour over') || n.includes('red espresso') ||
    n.includes('matcha')
  ) return 'coffee';
  if (
    n.includes('muffin') || n.includes('croissant') || n.includes('brownie') ||
    n.includes('cookie') || n.includes('cake') || n.includes('sandwich') ||
    n.includes('crunch') || n.includes('lemon') || n.includes('banana') ||
    n.includes('simple square') || n.includes('poppyseed')
  ) return 'food';
  if (n.includes('250g') || n.includes('750g') || n.includes('blend')) return 'retail';
  return 'other';
};

module.exports = { inferItemCategory };
