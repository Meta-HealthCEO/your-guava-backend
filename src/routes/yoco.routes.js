const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const Cafe = require('../models/Cafe.model');
const {
  getAuthorizationUrl,
  exchangeCode,
  getValidToken,
  fetchAllOrders,
  syncOrders,
  subscribeWebhook,
  processWebhookEvent,
} = require('../services/yoco.service');

// GET /api/yoco/auth — Get OAuth authorization URL
router.get('/auth', authMiddleware, (req, res) => {
  const state = req.user.cafeId;
  const url = getAuthorizationUrl(state);
  res.json({ success: true, url });
});

// POST /api/yoco/callback — Exchange OAuth code for tokens
router.post('/callback', authMiddleware, async (req, res, next) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, message: 'Authorization code required' });
    }

    const tokens = await exchangeCode(code);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    await Cafe.findByIdAndUpdate(req.user.cafeId, {
      $set: {
        yocoConnected: true,
        'yocoTokens.accessToken': tokens.access_token,
        'yocoTokens.refreshToken': tokens.refresh_token,
        'yocoTokens.expiresAt': expiresAt,
      },
    });

    res.json({ success: true, message: 'Yoco connected successfully' });
  } catch (error) {
    next(error);
  }
});

// GET /api/yoco/status — Check connection status
router.get('/status', authMiddleware, async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId).select(
      'yocoConnected lastSyncAt yocoTokens.expiresAt'
    );
    res.json({
      success: true,
      connected: cafe?.yocoConnected || false,
      lastSyncAt: cafe?.lastSyncAt || null,
      tokenExpiresAt: cafe?.yocoTokens?.expiresAt || null,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/yoco/sync — Manual full sync (pull all historical orders)
router.post('/sync', authMiddleware, async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId);
    if (!cafe?.yocoConnected) {
      return res.status(400).json({ success: false, message: 'Yoco not connected' });
    }

    const token = await getValidToken(cafe);

    // Sync last 6 months of data (or custom range)
    const { startDate, endDate } = req.body;
    const end = endDate ? new Date(endDate) : new Date();
    const start = startDate
      ? new Date(startDate)
      : new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);

    const orders = await fetchAllOrders(token, start, end);
    const result = await syncOrders(cafe._id, orders);

    // Update cafe
    await Cafe.findByIdAndUpdate(cafe._id, {
      dataUploaded: true,
      lastSyncAt: new Date(),
    });

    res.json({
      success: true,
      ...result,
      totalOrders: orders.length,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/yoco/webhook — Webhook handler (no auth — called by Yoco)
router.post('/webhook', async (req, res) => {
  try {
    // Respond quickly to Yoco (must respond within 15s)
    res.status(200).json({ received: true });

    // Process asynchronously
    processWebhookEvent(req.body).catch((err) => {
      console.error('[yoco webhook] Processing error:', err.message);
    });
  } catch {
    res.status(200).json({ received: true });
  }
});

// POST /api/yoco/disconnect — Disconnect Yoco
router.post('/disconnect', authMiddleware, async (req, res, next) => {
  try {
    await Cafe.findByIdAndUpdate(req.user.cafeId, {
      $set: { yocoConnected: false },
      $unset: { yocoTokens: 1, yocoBusinessId: 1 },
    });
    res.json({ success: true, message: 'Yoco disconnected' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
