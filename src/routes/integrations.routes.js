const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
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
router.get('/:provider/auth', ownerOnly, getAuthUrl);
router.post('/:provider/callback', ownerOnly, callback);
router.post('/:provider/sync', ownerOnly, sync);
router.post('/:provider/disconnect', ownerOnly, disconnect);

module.exports = router;
