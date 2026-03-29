const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { register, login, refresh, logout } = require('../controllers/auth.controller');

router.post('/register', register);
router.post('/login', login);
router.post('/refresh', refresh);
router.post('/logout', authMiddleware, logout);

module.exports = router;
