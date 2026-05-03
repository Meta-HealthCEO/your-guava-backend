const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const analytics = require('../controllers/analytics.controller');

router.use(authMiddleware);

router.get('/revenue', analytics.getRevenue);
router.get('/items', analytics.getItems);
router.get('/heatmap', analytics.getHeatmap);
router.get('/customers', analytics.getCustomers);
router.get('/waste', analytics.getWaste);
router.get('/combos', analytics.getCombos);

module.exports = router;
