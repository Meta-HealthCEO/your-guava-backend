const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { list, create, update, remove, eventEffects } = require('../controllers/events.controller');

router.use(authMiddleware);

router.get('/effects', eventEffects);
router.get('/', list);
router.post('/', create);
router.put('/:id', update);
router.delete('/:id', remove);

module.exports = router;
