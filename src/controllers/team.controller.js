const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');

// POST /api/team/invite — Owner invites a manager
const inviteManager = async (req, res, next) => {
  try {
    const { email, name, password, cafeIds } = req.body;

    if (!email || !name || !password) {
      return res.status(400).json({ success: false, message: 'Email, name, and password are required' });
    }

    // Verify requester is owner
    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can invite managers' });
    }

    // Check email not taken
    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Validate cafeIds belong to owner's org
    const orgCafes = await Cafe.find({ orgId: owner.orgId }).select('_id');
    const orgCafeIds = orgCafes.map((c) => c._id.toString());
    const validCafeIds = (cafeIds || []).filter((id) => orgCafeIds.includes(id));

    if (validCafeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid cafe must be assigned' });
    }

    // Create manager user
    const manager = await User.create({
      email,
      name,
      password,
      role: 'manager',
      orgId: owner.orgId,
      cafeIds: validCafeIds,
      activeCafeId: validCafeIds[0],
    });

    return res.status(201).json({
      success: true,
      manager: {
        id: manager._id,
        email: manager.email,
        name: manager.name,
        role: manager.role,
        cafeIds: manager.cafeIds,
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/team — List all team members in the org
const listTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const members = await User.find({ orgId: user.orgId })
      .select('name email role cafeIds activeCafeId createdAt')
      .populate('cafeIds', 'name')
      .lean();

    return res.status(200).json({ success: true, members });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/team/:userId — Owner removes a manager
const removeMember = async (req, res, next) => {
  try {
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(403).json({ success: false, message: 'User not in your organization' });
    }

    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'Cannot remove the owner' });
    }

    await User.findByIdAndDelete(target._id);

    return res.status(200).json({ success: true, message: 'Member removed' });
  } catch (error) {
    next(error);
  }
};

// PUT /api/team/:userId/cafes — Owner updates a manager's cafe access
const updateMemberCafes = async (req, res, next) => {
  try {
    const { cafeIds } = req.body;
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target || target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Validate cafeIds belong to org
    const orgCafes = await Cafe.find({ orgId: owner.orgId }).select('_id');
    const orgCafeIds = orgCafes.map((c) => c._id.toString());
    const validCafeIds = (cafeIds || []).filter((id) => orgCafeIds.includes(id));

    target.cafeIds = validCafeIds;
    if (!validCafeIds.includes(target.activeCafeId?.toString())) {
      target.activeCafeId = validCafeIds[0] || null;
    }
    await target.save();

    return res.status(200).json({ success: true, cafeIds: target.cafeIds });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/switch-cafe — Switch active cafe
const switchCafe = async (req, res, next) => {
  try {
    const { cafeId } = req.body;
    const user = await User.findById(req.user.id);

    if (!user.cafeIds.map((id) => id.toString()).includes(cafeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this cafe' });
    }

    user.activeCafeId = cafeId;
    await user.save();

    // Generate new tokens with updated cafeId
    const jwt = require('jsonwebtoken');
    const accessToken = jwt.sign(
      {
        id: user._id,
        cafeId: cafeId,
        role: user.role,
        orgId: user.orgId ? user.orgId.toString() : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    return res.status(200).json({ success: true, accessToken, activeCafeId: cafeId });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/add-cafe — Owner adds a new cafe to the org
const addCafe = async (req, res, next) => {
  try {
    const { name, address, city, lat, lng } = req.body;
    const owner = await User.findById(req.user.id);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Cafe name is required' });
    }

    const cafe = await Cafe.create({
      name,
      orgId: owner.orgId,
      location: { address, city: city || 'Cape Town', lat, lng },
    });

    // Add to owner's cafeIds
    owner.cafeIds.push(cafe._id);
    await owner.save();

    return res.status(201).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

module.exports = { inviteManager, listTeam, removeMember, updateMemberCafes, switchCafe, addCafe };
