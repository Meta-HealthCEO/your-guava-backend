const express = require('express');
const authMiddleware = require('../middleware/auth.middleware');
const { list, create, getOne, update, remove } = require('../controllers/insightChats.controller');

const router = express.Router();

router.use(authMiddleware);

router.get('/', list);
router.post('/', create);
router.get('/:id', getOne);
router.patch('/:id', update);
router.delete('/:id', remove);

module.exports = router;
