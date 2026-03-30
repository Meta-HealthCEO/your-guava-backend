const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { create, list, getWeek, getSummary, update, remove } = require('../controllers/shifts.controller');

router.use(authMiddleware);

router.post('/', create);
router.get('/', list);
router.get('/week', getWeek);
router.get('/summary', getSummary);
router.put('/:id', update);
router.delete('/:id', remove);

module.exports = router;
