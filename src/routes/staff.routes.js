const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth.middleware');
const { ownerOnly } = require('../middleware/rbac.middleware');
const { create, list, getOne, update, remove } = require('../controllers/staff.controller');

router.use(authMiddleware);

// Managers can see who works here (pay stripped in the controller); only the
// owner can hire, edit or deactivate staff.
router.post('/', ownerOnly, create);
router.get('/', list);
router.get('/:id', getOne);
router.put('/:id', ownerOnly, update);
router.delete('/:id', ownerOnly, remove);

module.exports = router;
