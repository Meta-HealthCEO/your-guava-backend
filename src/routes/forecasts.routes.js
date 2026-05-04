const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const {
  getToday,
  getWeek,
  generate,
  getAccuracy,
  getInsights,
  chatInsights,
  streamChatInsights,
  getRecent,
} = require('../controllers/forecasts.controller');

router.use(authMiddleware);

router.get('/today', getToday);
router.get('/tomorrow', require('../controllers/forecasts.controller').getTomorrow);
router.get('/week', getWeek);
router.get('/recent', getRecent);
router.post('/generate', generate);
router.get('/accuracy', getAccuracy);
router.get('/insights', getInsights);
router.post('/insights/chat', chatInsights);
router.post('/insights/chat/stream', streamChatInsights);

module.exports = router;
