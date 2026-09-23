const { buildSummaryStats } = require('./ai/prompts');
const { buildBusinessContext } = require('./ai/context');
const { generateBusinessChatResponse } = require('./ai/chat');
const { streamBusinessChatResponse } = require('./ai/stream');
const { proposeColumnMapping, _resetMappingCache } = require('./ai/columnMapping');
const { getCachedInsights, invalidateInsights, generateInsights, refreshInsights, _resetInsightsCache } = require('./ai/insights');

module.exports = {
  _resetInsightsCache,
  buildSummaryStats,
  _resetMappingCache,
  buildBusinessContext,
  invalidateInsights,
  getCachedInsights,
  generateInsights,
  generateBusinessChatResponse,
  proposeColumnMapping,
  refreshInsights,
  streamBusinessChatResponse,
};
