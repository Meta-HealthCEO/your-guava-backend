const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const uploads = require('../controllers/uploads.controller');

const router = express.Router();

router.post('/:id/confirm', authMiddleware, uploads.confirm);

module.exports = router;
