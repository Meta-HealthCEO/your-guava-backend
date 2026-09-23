const {
  MIN_HISTORY_WEEKS, requiredHistoryWeeks, forecastConfidence, groupByWeekAndItem, buildHistoryWeights, weightedAverage,
} = require('./forecast/history');
const { computeSuggestedStockFromPairs } = require('./forecast/stock');
const {
  FORECAST_MODEL_VERSION, MAX_STORED_FORECAST_ITEMS, getTradingAvailability, describeClosedDay, generateForecast, generateWeekForecast,
} = require('./forecast/generate');
const { updateForecastActuals, refreshForecastsAfterMenuChange, scheduleForecastRefreshAfterMenuChange } = require('./forecast/actuals');

module.exports = {
  FORECAST_MODEL_VERSION,
  MIN_HISTORY_WEEKS,
  MAX_STORED_FORECAST_ITEMS,
  generateForecast,
  generateWeekForecast,
  updateForecastActuals,
  refreshForecastsAfterMenuChange,
  scheduleForecastRefreshAfterMenuChange,
  _test: {
    buildHistoryWeights,
    groupByWeekAndItem,
    weightedAverage,
    getTradingAvailability,
    describeClosedDay,
    forecastConfidence,
    computeSuggestedStockFromPairs,
    requiredHistoryWeeks,
  },
};
