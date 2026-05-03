const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const uploads = require('../controllers/uploads.controller');

const router = express.Router();

router.get('/', authMiddleware, uploads.list);
router.get('/:id/rows', authMiddleware, uploads.rows);
router.get('/:id', authMiddleware, uploads.detail);
router.post('/:id/confirm', authMiddleware, uploads.confirm);
router.patch('/:id/mapping', authMiddleware, uploads.remap);
router.delete('/:id', authMiddleware, ownerOnly, uploads.remove);

module.exports = router;
