const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const { getPlan } = require('../services/billingPlans.service');
const emailService = require('../services/email.service');

const buildSeatSummary = async (orgId) => {
  const org = await Organization.findById(orgId).lean();
  const used = await User.countDocuments({ orgId });
  const plan = getPlan(org?.plan);
  return {
    plan: plan.id,
    used,
    included: plan.includedSeats,
    remaining: Math.max(0, plan.includedSeats - used),
  };
};

const validateCafeAccess = async (orgId, cafeIds = []) => {
  const orgCafes = await Cafe.find({ orgId }).select('_id');
  const orgCafeIds = orgCafes.map((cafe) => cafe._id.toString());
  return cafeIds.filter((id) => orgCafeIds.includes(id));
};

// Cryptographically random temporary password — never accepted from the client.
const generateTemporaryPassword = () => `Guava-${crypto.randomBytes(6).toString('base64url')}`;

// POST /api/team/invite - Owner adds a manager seat to the organisation.
const inviteManager = async (req, res, next) => {
  try {
    const { email, name, cafeIds } = req.body;

    if (!email || !name) {
      return res.status(400).json({ success: false, message: 'Email and name are required' });
    }

    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can add team members' });
    }

    const seats = await buildSeatSummary(owner.orgId);
    if (seats.remaining <= 0) {
      return res.status(402).json({
        success: false,
        message: `Seat limit reached on the ${seats.plan} plan. Upgrade your plan or remove a member.`,
        seats,
      });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    const validCafeIds = await validateCafeAccess(owner.orgId, cafeIds || []);
    if (validCafeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid cafe must be assigned' });
    }

    const temporaryPassword = generateTemporaryPassword();
    const manager = await User.create({
      email,
      name,
      password: temporaryPassword,
      role: 'manager',
      orgId: owner.orgId,
      cafeIds: validCafeIds,
      activeCafeId: validCafeIds[0],
    });

    const assignedCafes = await Cafe.find({ _id: { $in: validCafeIds } }).select('name').lean();
    let emailResult;
    try {
      emailResult = await emailService.sendTeamInviteEmail({
        manager,
        owner,
        cafes: assignedCafes,
        temporaryPassword,
      });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr };
      // Rollback happens below so the temporary password never leaves the server.
    }

    if (emailResult?.skipped || !emailResult?.sent) {
      // Do not leave an unreachable account behind if email delivery fails.
      await User.deleteOne({ _id: manager._id });
      const updatedSeats = await buildSeatSummary(owner.orgId);
      const providerMissing = emailResult?.skipped;
      const errorMessage = providerMissing
        ? 'Team invite email is not configured. Configure email delivery before inviting members.'
        : 'Team invite email could not be sent. No team member was created.';

      if (providerMissing) {
        console.warn(`[team] invite for ${manager.email} blocked because email is not configured`);
      } else {
        console.error('[team] invite email failed; manager invite rolled back:', emailResult?.error?.message || emailResult?.error || 'unknown error');
      }

      return res.status(providerMissing ? 503 : 502).json({
        success: false,
        message: errorMessage,
        emailSent: false,
        seats: updatedSeats,
      });
    }

    const updatedSeats = await buildSeatSummary(owner.orgId);

    return res.status(201).json({
      success: true,
      manager: {
        id: manager._id,
        _id: manager._id,
        email: manager.email,
        name: manager.name,
        role: manager.role,
        cafeIds: manager.cafeIds,
      },
      seats: updatedSeats,
      emailSent: true,
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/team - List all team members in the organisation.
const listTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    const members = await User.find({ orgId: user.orgId })
      .select('name email role cafeIds activeCafeId createdAt')
      .populate('cafeIds', 'name')
      .lean();
    const seats = await buildSeatSummary(user.orgId);

    return res.status(200).json({ success: true, members, seats });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/team/:userId - Owner removes a manager from the organisation.
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
    const seats = await buildSeatSummary(owner.orgId);

    return res.status(200).json({ success: true, message: 'Member removed', seats });
  } catch (error) {
    next(error);
  }
};

// PUT /api/team/:userId/cafes - Owner updates a manager's cafe access.
const updateMemberCafes = async (req, res, next) => {
  try {
    const { cafeIds } = req.body;
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target || target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const validCafeIds = await validateCafeAccess(owner.orgId, cafeIds || []);
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

// PATCH /api/team/:userId - Owner updates member profile and cafe access.
const updateMember = async (req, res, next) => {
  try {
    const { name, cafeIds } = req.body;
    const owner = await User.findById(req.user.id);
    const target = await User.findById(req.params.userId);

    if (!target || target.orgId.toString() !== owner.orgId.toString()) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'Owner details must be changed from My Account' });
    }

    if (name && name.trim().length >= 2) {
      target.name = name.trim();
    }

    if (Array.isArray(cafeIds)) {
      const validCafeIds = await validateCafeAccess(owner.orgId, cafeIds);
      if (validCafeIds.length === 0) {
        return res.status(400).json({ success: false, message: 'At least one valid cafe must be assigned' });
      }
      target.cafeIds = validCafeIds;
      if (!validCafeIds.includes(target.activeCafeId?.toString())) {
        target.activeCafeId = validCafeIds[0];
      }
    }

    await target.save();

    const member = await User.findById(target._id)
      .select('name email role cafeIds activeCafeId createdAt')
      .populate('cafeIds', 'name')
      .lean();

    return res.status(200).json({ success: true, member });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/switch-cafe - Switch active cafe.
const switchCafe = async (req, res, next) => {
  try {
    const { cafeId } = req.body;
    const user = await User.findById(req.user.id);

    if (!user.cafeIds.map((id) => id.toString()).includes(cafeId)) {
      return res.status(403).json({ success: false, message: 'You do not have access to this cafe' });
    }

    user.activeCafeId = cafeId;
    await user.save();

    const accessToken = jwt.sign(
      {
        id: user._id,
        cafeId,
        role: user.role,
        orgId: user.orgId ? user.orgId.toString() : null,
        tokenVersion: Number(user.tokenVersion || 0),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    return res.status(200).json({ success: true, accessToken, activeCafeId: cafeId });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/add-cafe - Owner adds a new cafe location to the organisation.
const addCafe = async (req, res, next) => {
  try {
    const { name, address, city, lat, lng } = req.body;
    const owner = await User.findById(req.user.id);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Cafe name is required' });
    }

    const org = await Organization.findById(owner.orgId);
    const plan = getPlan(org?.plan);
    const locationCount = await Cafe.countDocuments({ orgId: owner.orgId });
    if (locationCount >= plan.includedLocations) {
      return res.status(402).json({
        success: false,
        message: `Location limit reached on the ${plan.name} plan. Upgrade your plan to add more cafes.`,
        locations: {
          used: locationCount,
          included: plan.includedLocations,
          remaining: 0,
        },
      });
    }

    const cafe = await Cafe.create({
      name,
      orgId: owner.orgId,
      location: { address, city: city || 'Cape Town', lat, lng },
    });

    owner.cafeIds.push(cafe._id);
    await owner.save();

    return res.status(201).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  inviteManager,
  listTeam,
  removeMember,
  updateMemberCafes,
  updateMember,
  switchCafe,
  addCafe,
};
