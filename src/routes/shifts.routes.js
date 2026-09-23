const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { create, list, getWeek, getSummary, update, remove } = require('../controllers/shifts.controller');

router.use(authMiddleware);

// Workforce administration is owner-only (WS-07-T03); reads stay open to members.
router.post('/', ownerOnly, create);
router.get('/', list);
router.get('/week', getWeek);
router.get('/summary', getSummary);
router.put('/:id', ownerOnly, update);
router.delete('/:id', ownerOnly, remove);

module.exports = router;
