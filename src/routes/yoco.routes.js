const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { getTransactions } = require('../services/yoco.service');
const Cafe = require('../models/Cafe.model');

/**
 * POST /api/yoco/webhook
 * Handles incoming Yoco webhook events.
 * TODO: Implement full webhook processing (payment.succeeded, etc.)
 */
router.post('/webhook', (req, res) => {
  console.log('[yoco webhook] Received event:', JSON.stringify(req.body));
  // Acknowledge receipt immediately (Yoco expects a 200 quickly)
  res.status(200).json({ received: true });
});

/**
 * GET /api/yoco/sync
 * Manually triggers a sync of transactions from the Yoco API.
 * Protected route — requires a valid auth token.
 */
router.get('/sync', authMiddleware, async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId);
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }

    if (!cafe.yocoConnected || !cafe.yocoApiKey) {
      return res
        .status(400)
        .json({ success: false, message: 'Yoco not connected. Please connect Yoco first.' });
    }

    const startDate = cafe.lastSyncAt || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const endDate = new Date();

    const transactions = await getTransactions(cafe.yocoApiKey, startDate, endDate);

    return res.status(200).json({
      success: true,
      message: 'Sync complete (Yoco API not yet fully implemented)',
      transactionCount: transactions.length,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
