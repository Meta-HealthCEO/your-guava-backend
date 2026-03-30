const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { create, list, getOne, update, remove } = require('../controllers/staff.controller');

router.use(authMiddleware);

router.post('/', create);
router.get('/', list);
router.get('/:id', getOne);
router.put('/:id', update);
router.delete('/:id', remove);

module.exports = router;
