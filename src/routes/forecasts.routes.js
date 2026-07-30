const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { requireCreditSpend } = require('../middleware/rbac.middleware');
const { aiLimiter } = require('../middleware/rateLimit.middleware');
const { apiCache } = require('../middleware/cache.middleware');
const {
  getToday,
  getWeek,
  generate,
  getFactors,
  updateFactors,
  getAccuracy,
  getHistory,
  getInsights,
  refreshGeneratedInsights,
  chatInsights,
  streamChatInsights,
  getRecent,
} = require('../controllers/forecasts.controller');

router.use(authMiddleware);

const forecastCache = apiCache({ ttlMs: 30000, keyPrefix: 'forecasts' });
const historyCache = apiCache({ ttlMs: 10000, keyPrefix: 'forecast-history' });
const cacheHistoryReads = (req, res, next) => (
  req.query.backfill === 'sync' ? next() : historyCache(req, res, next)
);

router.get('/today', forecastCache, getToday);
router.get('/tomorrow', forecastCache, require('../controllers/forecasts.controller').getTomorrow);
router.get('/week', forecastCache, getWeek);
router.get('/recent', forecastCache, getRecent);
router.get('/history', cacheHistoryReads, getHistory);
router.get('/factors', getFactors);
router.put('/factors', updateFactors);
router.post('/generate', generate);
router.get('/accuracy', getAccuracy);
router.get('/insights', getInsights);
router.post('/insights/refresh', requireCreditSpend, aiLimiter, refreshGeneratedInsights);
router.post('/insights/chat', requireCreditSpend, aiLimiter, chatInsights);
router.post('/insights/chat/stream', requireCreditSpend, aiLimiter, streamChatInsights);

module.exports = router;
