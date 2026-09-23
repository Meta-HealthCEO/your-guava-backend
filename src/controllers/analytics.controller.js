const { getRevenue } = require('./analytics/revenue');
const { getItems } = require('./analytics/items');
const { getHeatmap } = require('./analytics/heatmap');
const { getCustomers } = require('./analytics/customers');
const { getCombos } = require('./analytics/combos');

module.exports = {
  getRevenue,
  getItems,
  getHeatmap,
  getCustomers,
  getCombos,
};
