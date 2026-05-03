const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const uploads = require('../controllers/uploads.controller');

const router = express.Router();

router.get('/', authMiddleware, uploads.list);
router.get('/:id/rows', authMiddleware, uploads.rows);
router.get('/:id', authMiddleware, uploads.detail);
router.post('/:id/confirm', authMiddleware, uploads.confirm);

module.exports = router;
