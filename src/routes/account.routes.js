const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  checkout,
  getAccount,
  getCreditBalance,
  getPaymentStatus,
  handleOneGateReturn,
  handleOneGateWebhook,
  updateProfile,
  buyAiCredits,
} = require('../controllers/account.controller');

const router = express.Router();

router.post('/payments/onegate/notify', handleOneGateWebhook);
router.get('/payments/onegate/return', handleOneGateReturn);

router.use(authMiddleware);

router.get('/credits', getCreditBalance);
router.get('/', getAccount);
router.patch('/profile', updateProfile);
router.post('/checkout', ownerOnly, checkout);
router.post('/ai-credits', ownerOnly, buyAiCredits);
router.get('/payments/:reference', ownerOnly, getPaymentStatus);

module.exports = router;
