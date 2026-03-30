const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { register, login, refresh, logout, me } = require('../controllers/auth.controller');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);
router.get('/me', authMiddleware, me);

module.exports = router;
