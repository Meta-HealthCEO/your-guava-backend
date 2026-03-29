const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { getMe, updateMe, connectYoco, getYocoStatus } = require('../controllers/cafe.controller');

router.use(authMiddleware);

router.get('/me', getMe);
router.put('/me', updateMe);
router.post('/yoco/connect', connectYoco);
router.get('/yoco/status', getYocoStatus);

module.exports = router;
