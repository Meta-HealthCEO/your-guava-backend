const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const {
  getAccount,
  updateProfile,
  mockCheckout,
  buyAiCredits,
} = require('../controllers/account.controller');

const router = express.Router();

router.use(authMiddleware);

router.get('/', getAccount);
router.patch('/profile', updateProfile);
router.post('/checkout', ownerOnly, mockCheckout);
router.post('/ai-credits', ownerOnly, buyAiCredits);

module.exports = router;
