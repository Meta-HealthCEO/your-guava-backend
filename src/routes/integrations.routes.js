const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const {
  list,
  getAuthUrl,
  callback,
  sync,
  disconnect,
} = require('../controllers/integrations.controller');

const router = express.Router();

router.use(authMiddleware);

router.get('/', list);
router.get('/:provider/auth', getAuthUrl);
router.post('/:provider/callback', callback);
router.post('/:provider/sync', sync);
router.post('/:provider/disconnect', disconnect);

module.exports = router;
