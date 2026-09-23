/**
 * Re-export barrel (BE-11-T04). Each analytics handler lives in ./analytics/*;
 * the date-range helpers in analytics/range.js. analytics.routes.js calls the
 * handlers on this object.
 */
const revenue = require('./analytics/revenue');
const items = require('./analytics/items');
const heatmap = require('./analytics/heatmap');
const customers = require('./analytics/customers');
const combos = require('./analytics/combos');

module.exports = {
  getCombos: combos.getCombos,
  getCustomers: customers.getCustomers,
  getHeatmap: heatmap.getHeatmap,
  getItems: items.getItems,
  getRevenue: revenue.getRevenue,
};
