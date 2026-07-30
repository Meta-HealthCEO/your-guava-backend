const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const TeamInvitation = require('../models/TeamInvitation.model');
const { getPlan } = require('../services/billingPlans.service');
const emailService = require('../services/email.service');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_BYTES = 72;
const DEFAULT_INVITE_TTL_HOURS = 48;
const MIN_INVITE_TTL_HOURS = 1;
const MAX_INVITE_TTL_HOURS = 168;
const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const INVALID_INVITATION_MESSAGE = 'This invitation is invalid or has expired';

const inviteTtlMs = () => {
  const configured = Number.parseInt(process.env.TEAM_INVITE_TTL_HOURS, 10);
  const hours = Number.isFinite(configured)
    ? Math.max(MIN_INVITE_TTL_HOURS, Math.min(MAX_INVITE_TTL_HOURS, configured))
    : DEFAULT_INVITE_TTL_HOURS;
  return hours * 60 * 60 * 1000;
};

const generateInvitationToken = () => crypto.randomBytes(32).toString('base64url');
const hashInvitationToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const normalizedInvitationToken = (value) => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return INVITE_TOKEN_RE.test(token) ? token : null;
};

const normalizeCafeIds = (cafeIds) =>
  [
    ...new Set(
      (Array.isArray(cafeIds) ? cafeIds : [])
        .map(String)
        .filter((id) => mongoose.isValidObjectId(id))
    ),
  ];

const invitationError = (statusCode = 404, message = INVALID_INVITATION_MESSAGE) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.isInvitationError = true;
  return error;
};

const invitationDto = (invitation) => ({
  id: invitation._id,
  _id: invitation._id,
  email: invitation.email,
  name: invitation.name,
  cafeIds: invitation.cafeIds,
  status: invitation.status,
  expiresAt: invitation.expiresAt,
  createdAt: invitation.createdAt,
});

const expirePendingInvitations = async (orgId, session = null) => {
  const query = {
    status: 'pending',
    expiresAt: { $lte: new Date() },
    ...(orgId ? { orgId } : {}),
  };
  const options = session ? { session } : undefined;
  await TeamInvitation.updateMany(query, { $set: { status: 'expired' } }, options);
};

const buildSeatSummary = async (orgId) => {
  await expirePendingInvitations(orgId);
  const org = await Organization.findById(orgId).lean();
  const [active, pending] = await Promise.all([
    User.countDocuments({ orgId }),
    TeamInvitation.countDocuments({
      orgId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }),
  ]);
  const used = active + pending;
  const plan = getPlan(org?.plan);
  return {
    plan: plan.id,
    used,
    active,
    pending,
    included: plan.includedSeats,
    remaining: Math.max(0, plan.includedSeats - used),
  };
};

const validateCafeAccess = async (orgId, cafeIds = [], session = null) => {
  const requestedIds = [...new Set((Array.isArray(cafeIds) ? cafeIds : []).map(String))];
  const query = Cafe.find({ orgId, _id: { $in: requestedIds } }).select('_id');
  if (session) query.session(session);
  const orgCafes = await query;
  const orgCafeIds = orgCafes.map((cafe) => cafe._id.toString());
  return requestedIds.filter((id) => orgCafeIds.includes(id));
};

// POST /api/team/invite - Owner sends a single-use manager invitation.
const inviteManager = async (req, res, next) => {
  let session;
  try {
    const { email, name, cafeIds } = req.body;

    const normalizedEmail = typeof email === 'string' ? email.toLowerCase().trim() : '';
    const normalizedName = typeof name === 'string' ? name.trim() : '';
    const submittedCafeIds = Array.isArray(cafeIds) ? cafeIds.map(String) : [];
    const requestedCafeIds = normalizeCafeIds(cafeIds);
    if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 254) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    if (
      requestedCafeIds.length === 0 ||
      requestedCafeIds.length !== new Set(submittedCafeIds).size
    ) {
      return res.status(400).json({ success: false, message: 'Select valid cafe access' });
    }

    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can add team members' });
    }

    const invitationToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(invitationToken);
    let invitation;
    let validCafeIds;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Touching the organization serializes quota decisions for this tenant.
      // Concurrent invites then conflict and retry against the committed count.
      const org = await Organization.findOneAndUpdate(
        { _id: owner.orgId },
        { $set: { updatedAt: new Date() } },
        { new: true, session }
      );
      if (!org) {
        const error = new Error('Organization not found');
        error.statusCode = 404;
        throw error;
      }

      await expirePendingInvitations(owner.orgId, session);

      const existing = await User.findOne({ email: normalizedEmail }).session(session);
      if (existing) {
        const error = new Error('Email already registered');
        error.statusCode = 409;
        throw error;
      }

      const existingInvitation = await TeamInvitation.findOne({
        orgId: owner.orgId,
        email: normalizedEmail,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      if (existingInvitation) {
        const error = new Error('An invitation is already pending for this email');
        error.statusCode = 409;
        throw error;
      }

      validCafeIds = await validateCafeAccess(owner.orgId, requestedCafeIds, session);
      if (validCafeIds.length !== requestedCafeIds.length) {
        const error = new Error('Select valid cafe access');
        error.statusCode = 400;
        throw error;
      }

      const activeSeats = await User.countDocuments({ orgId: owner.orgId }).session(session);
      const pendingSeats = await TeamInvitation.countDocuments({
        orgId: owner.orgId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      const used = activeSeats + pendingSeats;
      const plan = getPlan(org.plan);
      if (used >= plan.includedSeats) {
        const error = new Error(
          `Seat limit reached on the ${plan.id} plan. Upgrade your plan or remove a member.`
        );
        error.statusCode = 402;
        error.seats = {
          plan: plan.id,
          used,
          active: activeSeats,
          pending: pendingSeats,
          included: plan.includedSeats,
          remaining: 0,
        };
        throw error;
      }

      [invitation] = await TeamInvitation.create([{
        email: normalizedEmail,
        name: normalizedName,
        orgId: owner.orgId,
        invitedByUserId: owner._id,
        cafeIds: validCafeIds,
        tokenHash,
        expiresAt: new Date(Date.now() + inviteTtlMs()),
      }], { session });
    });

    const assignedCafes = await Cafe.find({
      _id: { $in: validCafeIds },
      orgId: owner.orgId,
    }).select('name').lean();
    let emailResult;
    try {
      emailResult = await emailService.sendTeamInviteEmail({
        invitation,
        owner,
        cafes: assignedCafes,
        invitationToken,
      });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr };
    }

    if (emailResult?.skipped || !emailResult?.sent) {
      // A failed delivery must not reserve a seat or leave a usable token behind.
      await TeamInvitation.updateOne(
        { _id: invitation._id, status: 'pending', tokenHash },
        { $set: { status: 'revoked', revokedAt: new Date() } }
      );
      const updatedSeats = await buildSeatSummary(owner.orgId);
      const providerMissing = emailResult?.skipped;
      const errorMessage = providerMissing
        ? 'Team invite email is not configured. Configure email delivery before inviting members.'
        : 'Team invite email could not be sent. No usable invitation remains.';

      if (providerMissing) {
        console.warn(`[team] invitation ${invitation._id} blocked because email is not configured`);
      } else {
        console.error(
          `[team] invitation ${invitation._id} email failed and was revoked:`,
          emailResult?.error?.message || 'unknown error'
        );
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
      invitation: invitationDto(invitation),
      seats: updatedSeats,
      emailSent: true,
    });
  } catch (error) {
    if (error?.statusCode === 402 && error?.seats) {
      return res.status(402).json({
        success: false,
        message: error.message,
        seats: error.seats,
      });
    }
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'An invitation is already pending for this email',
      });
    }
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// GET /api/team - List all team members in the organisation.
const listTeam = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    await expirePendingInvitations(user.orgId);
    const members = await User.find({ orgId: user.orgId })
      .select('name email role cafeIds activeCafeId createdAt')
      .populate('cafeIds', 'name')
      .lean();
    const invitations = await TeamInvitation.find({
      orgId: user.orgId,
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .select('name email cafeIds status expiresAt createdAt')
      .populate('cafeIds', 'name')
      .sort({ createdAt: -1 })
      .lean();
    const seats = await buildSeatSummary(user.orgId);

    return res.status(200).json({ success: true, members, invitations, seats });
  } catch (error) {
    next(error);
  }
};

// POST /api/team/invitations/preview - Public capability-token lookup.
const previewInvitation = async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedInvitationToken(req.body?.token);
    if (!token) throw invitationError();

    const invitation = await TeamInvitation.findOne({
      tokenHash: hashInvitationToken(token),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    }).lean();
    if (!invitation) throw invitationError();

    const [org, cafes] = await Promise.all([
      Organization.findById(invitation.orgId).select('name ownerId').lean(),
      Cafe.find({
        _id: { $in: invitation.cafeIds },
        orgId: invitation.orgId,
      }).select('name').lean(),
    ]);
    if (
      !org ||
      String(org.ownerId) !== String(invitation.invitedByUserId) ||
      cafes.length !== invitation.cafeIds.length
    ) {
      throw invitationError();
    }

    return res.status(200).json({
      success: true,
      invitation: {
        email: invitation.email,
        name: invitation.name,
        organizationName: org.name,
        cafeNames: cafes.map((cafe) => cafe.name),
        expiresAt: invitation.expiresAt,
      },
    });
  } catch (error) {
    if (error?.isInvitationError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return next(error);
  }
};

// POST /api/team/invitations/accept - Sets the manager's password exactly once.
const acceptInvitation = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedInvitationToken(req.body?.token);
    const password = req.body?.password;
    if (!token) throw invitationError();
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters',
      });
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return res.status(400).json({
        success: false,
        message: `Password cannot exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
      });
    }

    const tokenHash = hashInvitationToken(token);
    let manager;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Read the capability first, then take the organization lock before
      // mutating it. Resend and invite use the same lock order, avoiding a
      // lock inversion while still re-checking the token atomically below.
      const candidate = await TeamInvitation.findOne(
        {
          tokenHash,
          status: 'pending',
          expiresAt: { $gt: new Date() },
        }
      ).session(session);
      if (!candidate) throw invitationError();

      // Serializing on the organization makes concurrent seat acceptance exact.
      const org = await Organization.findOneAndUpdate(
        { _id: candidate.orgId, ownerId: candidate.invitedByUserId },
        { $set: { updatedAt: new Date() } },
        { new: true, session }
      );
      if (!org) throw invitationError();

      const invitation = await TeamInvitation.findOneAndUpdate(
        {
          _id: candidate._id,
          tokenHash,
          status: 'pending',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'accepting' } },
        { new: true, session }
      );
      if (!invitation) throw invitationError();

      const owner = await User.findOne({
        _id: invitation.invitedByUserId,
        orgId: invitation.orgId,
        role: 'owner',
      }).session(session);
      if (!owner) throw invitationError();

      const requestedCafeIds = invitation.cafeIds.map(String);
      const validCafeIds = await validateCafeAccess(invitation.orgId, requestedCafeIds, session);
      if (validCafeIds.length === 0 || validCafeIds.length !== requestedCafeIds.length) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      const activeSeats = await User.countDocuments({ orgId: invitation.orgId }).session(session);
      if (activeSeats >= getPlan(org.plan).includedSeats) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      const existing = await User.findOne({ email: invitation.email }).session(session);
      if (existing) {
        throw invitationError(409, 'This invitation cannot be accepted. Ask the account owner for a new invitation.');
      }

      [manager] = await User.create([{
        email: invitation.email,
        name: invitation.name,
        password,
        role: 'manager',
        orgId: invitation.orgId,
        cafeIds: validCafeIds,
        activeCafeId: validCafeIds[0],
      }], { session });

      invitation.status = 'accepted';
      invitation.acceptedAt = new Date();
      await invitation.save({ session });
    });

    return res.status(201).json({
      success: true,
      message: 'Invitation accepted. You can now sign in.',
      user: { email: manager.email },
    });
  } catch (error) {
    if (error?.isInvitationError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'This invitation cannot be accepted. Ask the account owner for a new invitation.',
      });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// POST /api/team/invitations/:invitationId/resend - Rotate the token and expiry.
const resendInvitation = async (req, res, next) => {
  let session;
  try {
    if (!mongoose.isValidObjectId(req.params.invitationId)) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    const owner = await User.findById(req.user.id);
    if (!owner || owner.role !== 'owner') {
      return res.status(403).json({ success: false, message: 'Only owners can resend invitations' });
    }

    const invitationToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(invitationToken);
    let invitation;
    let validCafeIds;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const org = await Organization.findOneAndUpdate(
        { _id: owner.orgId, ownerId: owner._id },
        { $set: { updatedAt: new Date() } },
        { new: true, session }
      );
      if (!org) throw invitationError(404, 'Invitation not found');

      await expirePendingInvitations(owner.orgId, session);
      invitation = await TeamInvitation.findOne({
        _id: req.params.invitationId,
        orgId: owner.orgId,
        status: { $in: ['pending', 'expired'] },
      }).select('+tokenHash').session(session);
      if (!invitation) throw invitationError(404, 'Invitation not found');

      const existing = await User.findOne({ email: invitation.email }).session(session);
      if (existing) throw invitationError(409, 'An account already exists for this email');

      const requestedCafeIds = invitation.cafeIds.map(String);
      validCafeIds = await validateCafeAccess(owner.orgId, requestedCafeIds, session);
      if (validCafeIds.length === 0 || validCafeIds.length !== requestedCafeIds.length) {
        throw invitationError(409, 'Update this invitation with valid cafe access before resending');
      }

      const activeSeats = await User.countDocuments({ orgId: owner.orgId }).session(session);
      const pendingSeats = await TeamInvitation.countDocuments({
        _id: { $ne: invitation._id },
        orgId: owner.orgId,
        status: 'pending',
        expiresAt: { $gt: new Date() },
      }).session(session);
      const used = activeSeats + pendingSeats;
      const plan = getPlan(org.plan);
      if (used >= plan.includedSeats) {
        const error = new Error(`Seat limit reached on the ${plan.id} plan`);
        error.statusCode = 402;
        throw error;
      }

      invitation.tokenHash = tokenHash;
      invitation.status = 'pending';
      invitation.expiresAt = new Date(Date.now() + inviteTtlMs());
      invitation.revokedAt = undefined;
      invitation.acceptedAt = undefined;
      await invitation.save({ session });
    });

    const assignedCafes = await Cafe.find({
      _id: { $in: validCafeIds },
      orgId: owner.orgId,
    }).select('name').lean();
    let emailResult;
    try {
      emailResult = await emailService.sendTeamInviteEmail({
        invitation,
        owner,
        cafes: assignedCafes,
        invitationToken,
      });
    } catch (emailErr) {
      emailResult = { sent: false, error: emailErr };
    }

    if (emailResult?.skipped || !emailResult?.sent) {
      await TeamInvitation.updateOne(
        { _id: invitation._id, status: 'pending', tokenHash },
        { $set: { status: 'revoked', revokedAt: new Date() } }
      );
      return res.status(emailResult?.skipped ? 503 : 502).json({
        success: false,
        message: emailResult?.skipped
          ? 'Team invite email is not configured. Configure email delivery before resending.'
          : 'Team invite email could not be sent. The invitation was revoked.',
        seats: await buildSeatSummary(owner.orgId),
      });
    }

    return res.status(200).json({
      success: true,
      invitation: invitationDto(invitation),
      seats: await buildSeatSummary(owner.orgId),
      emailSent: true,
    });
  } catch (error) {
    if (error?.isInvitationError || (error?.statusCode && error.statusCode < 500)) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'An invitation is already pending for this email' });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

// DELETE /api/team/invitations/:invitationId - Revoke an unused invite token.
const revokeInvitation = async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.invitationId)) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    const invitation = await TeamInvitation.findOneAndUpdate(
      {
        _id: req.params.invitationId,
        orgId: req.user.orgId,
        status: 'pending',
      },
      { $set: { status: 'revoked', revokedAt: new Date() } },
      { new: true }
    );
    if (!invitation) {
      return res.status(404).json({ success: false, message: 'Invitation not found' });
    }
    return res.status(200).json({
      success: true,
      message: 'Invitation revoked',
      seats: await buildSeatSummary(req.user.orgId),
    });
  } catch (error) {
    return next(error);
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
    if (target.role === 'owner') {
      return res.status(403).json({ success: false, message: 'Owner cafe access cannot be changed here' });
    }

    const validCafeIds = await validateCafeAccess(owner.orgId, cafeIds || []);
    if (validCafeIds.length === 0) {
      return res.status(400).json({ success: false, message: 'At least one valid cafe must be assigned' });
    }
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
  let session;
  try {
    const { name, address, city, lat, lng } = req.body;
    const owner = await User.findById(req.user.id);

    if (!name) {
      return res.status(400).json({ success: false, message: 'Cafe name is required' });
    }

    const parsedLat = lat == null || lat === '' ? undefined : Number(lat);
    const parsedLng = lng == null || lng === '' ? undefined : Number(lng);
    if ((parsedLat === undefined) !== (parsedLng === undefined)) {
      return res.status(400).json({ success: false, message: 'lat and lng must be provided together' });
    }
    if (
      (parsedLat !== undefined && (!Number.isFinite(parsedLat) || parsedLat < -90 || parsedLat > 90)) ||
      (parsedLng !== undefined && (!Number.isFinite(parsedLng) || parsedLng < -180 || parsedLng > 180))
    ) {
      return res.status(400).json({ success: false, message: 'Invalid latitude or longitude' });
    }

    let cafe;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const org = await Organization.findOneAndUpdate(
        { _id: owner.orgId },
        { $set: { updatedAt: new Date() } },
        { new: true, session }
      );
      if (!org) {
        const error = new Error('Organization not found');
        error.statusCode = 404;
        throw error;
      }

      const plan = getPlan(org.plan);
      const locationCount = await Cafe.countDocuments({ orgId: owner.orgId }).session(session);
      if (locationCount >= plan.includedLocations) {
        const error = new Error(
          `Location limit reached on the ${plan.name} plan. Upgrade your plan to add more cafes.`
        );
        error.statusCode = 402;
        error.locations = {
          used: locationCount,
          included: plan.includedLocations,
          remaining: 0,
        };
        throw error;
      }

      [cafe] = await Cafe.create([{
        name: String(name).trim(),
        orgId: owner.orgId,
        location: {
          ...(address ? { address: String(address).trim() } : {}),
          ...(city ? { city: String(city).trim() } : {}),
          ...(parsedLat !== undefined ? { lat: parsedLat, lng: parsedLng } : {}),
        },
      }], { session });

      await User.updateOne(
        { _id: owner._id, orgId: owner.orgId },
        { $addToSet: { cafeIds: cafe._id } },
        { session }
      );
    });

    return res.status(201).json({ success: true, cafe });
  } catch (error) {
    if (error?.statusCode === 402 && error?.locations) {
      return res.status(402).json({
        success: false,
        message: error.message,
        locations: error.locations,
      });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

module.exports = {
  inviteManager,
  previewInvitation,
  acceptInvitation,
  resendInvitation,
  revokeInvitation,
  listTeam,
  removeMember,
  updateMemberCafes,
  updateMember,
  switchCafe,
  addCafe,
};
