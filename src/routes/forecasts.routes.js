const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
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
  chatInsights,
  streamChatInsights,
  getRecent,
} = require('../controllers/forecasts.controller');

router.use(authMiddleware);

const forecastCache = apiCache({ ttlMs: 30000, keyPrefix: 'forecasts' });
const historyCache = apiCache({ ttlMs: 10000, keyPrefix: 'forecast-history' });

router.get('/today', forecastCache, getToday);
router.get('/tomorrow', forecastCache, require('../controllers/forecasts.controller').getTomorrow);
router.get('/week', forecastCache, getWeek);
router.get('/recent', forecastCache, getRecent);
router.get('/history', historyCache, getHistory);
router.get('/factors', getFactors);
router.put('/factors', updateFactors);
router.post('/generate', generate);
router.get('/accuracy', getAccuracy);
router.get('/insights', getInsights);
router.post('/insights/chat', chatInsights);
router.post('/insights/chat/stream', streamChatInsights);

module.exports = router;
