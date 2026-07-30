const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const items = require('../controllers/items.controller');

router.use(authMiddleware);

router.get('/', items.list);
router.post('/', items.create);
router.get('/reconciliation', items.reconciliation);
router.post('/reconciliation/suggestions', items.generateReconciliationSuggestions);
router.put('/:id', items.update);
router.post('/:id/resolve', items.resolve);

module.exports = router;
