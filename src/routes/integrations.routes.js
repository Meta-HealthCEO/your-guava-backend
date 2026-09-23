const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  list,
  getAuthUrl,
  callback,
  sync,
  disconnect,
  validateProviderParam,
} = require('../controllers/integrations.controller');

const router = express.Router();

router.use(authMiddleware);
// One provider check for every /:provider route, before the feature flag and the owner check.
router.param('provider', validateProviderParam);

router.get('/', list);
router.get('/:provider/auth', ownerOnly, getAuthUrl);
router.post('/:provider/callback', ownerOnly, callback);
router.post('/:provider/sync', ownerOnly, sync);
router.post('/:provider/disconnect', ownerOnly, disconnect);

module.exports = router;
