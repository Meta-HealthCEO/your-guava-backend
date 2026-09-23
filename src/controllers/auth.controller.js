const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const TeamInvitation = require('../models/TeamInvitation.model');
const PendingRegistration = require('../models/PendingRegistration.model');
const PasswordResetToken = require('../models/PasswordResetToken.model');
const AuthSession = require('../models/AuthSession.model');
const AccessAuditEvent = require('../models/AccessAuditEvent.model');
const emailService = require('../services/email.service');
const { isValidEmail } = require('../utils/email');
const { passwordTooLong, passwordInputError, dummyPasswordHash } = require('../utils/password');
const { runAfterResponse } = require('../utils/afterResponse');

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// Max active refresh-token families per user (roughly one per device).
const MAX_REFRESH_TOKENS = 10;
const ACTION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const REFRESH_REUSE_GRACE_MS = 5 * 1000;
const MAX_VERIFICATION_RESENDS = 5;
const MAX_VERIFY_PASSWORD_ATTEMPTS = 5;
const INVALID_VERIFICATION_MESSAGE = 'This verification link is invalid or has expired';
// One answer for every address that is accepted, so the page cannot tell a pending signup from a new one (and, after
// BE-02-T02, from an existing account).
const REGISTER_ACCEPTED_MESSAGE =
  'Check your inbox for the next step. If this email can start a new account, the link to finish signing up is there. ' +
  'If it already has an account, we have sent sign-in help instead.';

// New, pending and existing addresses leave register through this one function, so their answers cannot drift apart.
const respondToRegistration = (res, emailResult, email) => {
  if (!emailResult?.sent) {
    console.error(
      '[auth] Registration email could not be sent:',
      emailResult?.error?.message || emailResult?.reason || 'unknown error'
    );
    return res.status(emailResult?.skipped ? 503 : 502).json({
      success: false,
      verificationRequired: true,
      code: 'VERIFICATION_EMAIL_FAILED',
      message: 'Your registration is saved, but the verification email could not be sent. Try resending it.',
    });
  }
  return res.status(202).json({ success: true, verificationRequired: true, email, message: REGISTER_ACCEPTED_MESSAGE });
};

// Identity-1: a new submission replaces a pending one (password, names, token), so the old link dies. Two simultaneous
// submissions race on the unique email index; the loser retries once and then updates the winner's document.
const upsertPendingRegistration = async (fields) => {
  const write = () => PendingRegistration.findOneAndUpdate(
    { email: fields.email },
    {
      $set: {
        passwordHash: fields.passwordHash,
        name: fields.name,
        cafeName: fields.cafeName,
        orgName: fields.orgName,
        tokenHash: fields.tokenHash,
        expiresAt: fields.expiresAt,
        resendCount: 0,
        verifyAttempts: 0,
      },
      $setOnInsert: { email: fields.email },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
  try {
    return await write();
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.email) return write();
    throw error;
  }
};

const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const generateActionToken = () => crypto.randomBytes(32).toString('base64url');
const hashActionToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const normalizedActionToken = (value) => {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return ACTION_TOKEN_RE.test(token) ? token : null;
};

const refreshTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + COOKIE_OPTIONS.maxAge);
};

const generateAccessToken = (userId, cafeId, role, orgId, tokenVersion = 0) =>
  jwt.sign(
    {
      id: userId,
      cafeId: cafeId ? cafeId.toString() : null,
      role: role || 'owner',
      orgId: orgId ? orgId.toString() : null,
      tokenVersion: Number(tokenVersion || 0),
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

const generateRefreshToken = (
  userId,
  familyId,
  {
    tokenId = crypto.randomUUID(),
    issuedAt = Math.floor(Date.now() / 1000),
    expiresAt,
  } = {}
) => {
  const payload = {
    id: userId,
    sid: familyId,
    jti: tokenId,
    iat: issuedAt,
    ...(Number.isFinite(expiresAt) ? { exp: expiresAt } : {}),
  };
  return jwt.sign(
    payload,
    process.env.JWT_REFRESH_SECRET,
    Number.isFinite(expiresAt)
      ? {}
      : { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );
};

const pruneAuthSessions = async (userId) => {
  const stale = await AuthSession.find({ userId, revokedAt: null })
    .sort({ createdAt: -1, _id: -1 })
    .skip(MAX_REFRESH_TOKENS)
    .select('_id')
    .lean();
  if (stale.length > 0) {
    await AuthSession.updateMany(
      { _id: { $in: stale.map((entry) => entry._id) }, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: 'session_limit' } }
    );
  }
};

const issueSession = async (user) => {
  const familyId = crypto.randomUUID();
  const refreshToken = generateRefreshToken(user._id, familyId);
  await AuthSession.create({
    userId: user._id,
    familyId,
    currentTokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshTokenExpiry(refreshToken),
  });
  await pruneAuthSessions(user._id);

  return {
    accessToken: generateAccessToken(
      user._id,
      user.activeCafeId,
      user.role,
      user.orgId,
      user.tokenVersion
    ),
    refreshToken,
  };
};

const register = async (req, res, next) => {
  try {
    const { email, password, name, cafeName, orgName } = req.body;

    if (!email || !password || !name) {
      return res
        .status(400)
        .json({ success: false, message: 'Email, password, and name are required' });
    }

    const passwordError = passwordInputError(password);
    if (passwordError) {
      return res.status(400).json({ success: false, message: passwordError });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedName = String(name).trim();
    const suppliedCafeName = cafeName == null ? '' : String(cafeName).trim();
    const suppliedOrgName = orgName == null ? '' : String(orgName).trim();
    const normalizedCafeName = suppliedCafeName || 'My Cafe';
    const normalizedOrgName =
      suppliedOrgName || `${normalizedName}'s Organization`.slice(0, 120);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ success: false, message: 'Enter a valid email address' });
    }
    if (normalizedName.length < 2 || normalizedName.length > 120) {
      return res.status(400).json({ success: false, message: 'Name must be between 2 and 120 characters' });
    }
    if (normalizedCafeName.length < 2 || normalizedCafeName.length > 120) {
      return res.status(400).json({ success: false, message: 'Cafe name must be between 2 and 120 characters' });
    }
    if (normalizedOrgName.length < 2 || normalizedOrgName.length > 120) {
      return res.status(400).json({ success: false, message: 'Organization name must be between 2 and 120 characters' });
    }

    const existingUser = await User.findOne({ email: normalizedEmail }).select('_id').lean();
    if (existingUser) {
      // Identity-4: same status, body and work as a new address: one bcrypt hash, one email.
      await bcrypt.hash(password, 10);
      const notice = await emailService.sendAccountExistsEmail({ user: { email: normalizedEmail } });
      return respondToRegistration(res, notice, normalizedEmail);
    }

    // Identity-3: a pending team invitation in any org no longer blocks a public signup.
    const verificationToken = generateActionToken();
    const registration = await upsertPendingRegistration({
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(password, 10),
      name: normalizedName,
      cafeName: normalizedCafeName,
      orgName: normalizedOrgName,
      tokenHash: hashActionToken(verificationToken),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    });

    const emailResult = await emailService.sendVerificationEmail({
      registration,
      verificationToken,
    });
    return respondToRegistration(res, emailResult, normalizedEmail);
  } catch (error) {
    next(error);
  }
};

// Runs after the response (identity-4): rotating and emailing must not decide how long the answer takes.
const rotateVerification = async (normalizedEmail) => {
  const verificationToken = generateActionToken();
  const tokenHash = hashActionToken(verificationToken);
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_MS);
  const previousRegistration = await PendingRegistration.findOneAndUpdate(
    {
      email: normalizedEmail,
      expiresAt: { $gt: new Date() },
      // $not also matches records written before this field existed.
      resendCount: { $not: { $gte: MAX_VERIFICATION_RESENDS } },
    },
    { $set: { tokenHash, expiresAt }, $inc: { resendCount: 1 } },
    { new: false, runValidators: true }
  ).select('+tokenHash');
  if (!previousRegistration) return;
  const registration = {
    ...previousRegistration.toObject(),
    tokenHash: undefined,
    expiresAt,
  };
  const result = await emailService.sendVerificationEmail({ registration, verificationToken });
  if (!result?.sent) {
    await PendingRegistration.updateOne(
      { _id: previousRegistration._id, tokenHash },
      {
        $set: {
          tokenHash: previousRegistration.tokenHash,
          expiresAt: previousRegistration.expiresAt,
        },
      }
    );
    console.error(
      '[auth] Verification resend failed:',
      result?.error?.message || result?.reason || 'unknown error'
    );
  }
};

const resendVerification = async (req, res, next) => {
  try {
    const normalizedEmail =
      typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    const genericResponse = {
      success: true,
      message: 'If a pending registration exists, a new verification email has been sent.',
    };
    if (isValidEmail(normalizedEmail)) {
      runAfterResponse('verification resend', () => rotateVerification(normalizedEmail));
    }
    return res.status(200).json(genericResponse);
  } catch (error) {
    return next(error);
  }
};

const verifyEmail = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedActionToken(req.body?.token);
    if (!token) {
      return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
    }
    const password = req.body?.password;
    if (typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({
        success: false,
        code: 'PASSWORD_REQUIRED',
        message: 'Enter the password you chose when you signed up.',
      });
    }

    const tokenHash = hashActionToken(token);
    const candidate = await PendingRegistration.findOne({ tokenHash, expiresAt: { $gt: new Date() } })
      .select('+passwordHash');
    if (!candidate) {
      return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
    }

    // Identity-1: never complete a sign-up with credentials the person holding the link did not supply.
    const matches = !passwordTooLong(password) && await bcrypt.compare(password, candidate.passwordHash);
    if (!matches) {
      const counted = await PendingRegistration.findOneAndUpdate(
        { _id: candidate._id, tokenHash },
        { $inc: { verifyAttempts: 1 } },
        { new: true }
      ).lean();
      const attempts = counted ? counted.verifyAttempts : MAX_VERIFY_PASSWORD_ATTEMPTS;
      if (attempts >= MAX_VERIFY_PASSWORD_ATTEMPTS) {
        await PendingRegistration.deleteOne({ _id: candidate._id, tokenHash });
        return res.status(404).json({ success: false, message: INVALID_VERIFICATION_MESSAGE });
      }
      return res.status(401).json({
        success: false,
        code: 'VERIFICATION_PASSWORD_MISMATCH',
        attemptsRemaining: MAX_VERIFY_PASSWORD_ATTEMPTS - attempts,
        message: 'That is not the password used for this sign-up. If you did not sign up, you can ignore the email.',
      });
    }

    let user;
    let org;
    let cafe;
    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      // Consume exactly the record whose password was checked: a register that replaced it in between changed the
      // tokenHash, so this finds nothing and the newer submission wins.
      const registration = await PendingRegistration.findOneAndDelete({
        _id: candidate._id,
        tokenHash,
        expiresAt: { $gt: new Date() },
      })
        .select('+passwordHash')
        .session(session);
      if (!registration) {
        const error = new Error(INVALID_VERIFICATION_MESSAGE);
        error.statusCode = 404;
        throw error;
      }
      const existingUser = await User.findOne({ email: registration.email }).session(session);
      if (existingUser) {
        const error = new Error('Email already registered');
        error.statusCode = 409;
        throw error;
      }

      [user] = await User.create([{
        email: registration.email,
        password: generateActionToken(),
        name: registration.name,
        role: 'owner',
        emailVerified: true,
        emailVerifiedAt: new Date(),
      }], { session });
      await User.updateOne(
        { _id: user._id },
        { $set: { password: registration.passwordHash } },
        { session, runValidators: false }
      );
      [org] = await Organization.create([{
        name: registration.orgName,
        ownerId: user._id,
        billingEmail: registration.email,
      }], { session });
      [cafe] = await Cafe.create([{ name: registration.cafeName, orgId: org._id }], { session });
      await User.updateOne(
        { _id: user._id },
        { $set: { orgId: org._id, cafeIds: [cafe._id], activeCafeId: cafe._id } },
        { session }
      );
      user.orgId = org._id;
      user.cafeIds = [cafe._id];
      user.activeCafeId = cafe._id;

      // Identity-3: the self-registration wins. Invitations to this address stop holding a seat and can no longer be accepted.
      await TeamInvitation.updateMany(
        { email: registration.email, status: 'pending' },
        { $set: { status: 'expired', expiresAt: new Date() } },
        { session }
      );
    });

    emailService.sendWelcomeEmail({ user, org, cafe }).catch((error) => {
      console.warn('[auth] Welcome email failed after verification:', error.message);
    });
    return res.status(201).json({
      success: true,
      message: 'Email verified. You can now sign in.',
      email: user.email,
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    if (error?.code === 11000) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || typeof password !== 'string' || password.length === 0) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    if (!isValidEmail(normalizedEmail) || passwordTooLong(password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password');
    if (!user) {
      // Identity-4: an unknown address costs the same bcrypt compare as a wrong password for a real one.
      await bcrypt.compare(password, await dummyPasswordHash());
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    if (user.emailVerified === false) {
      return res.status(403).json({
        success: false,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email address before signing in',
      });
    }

    const { accessToken, refreshToken } = await issueSession(user);

    const cookieOptions = {
      ...COOKIE_OPTIONS,
      secure: process.env.NODE_ENV === 'production',
    };

    res.cookie('refreshToken', refreshToken, cookieOptions);

    return res.status(200).json({
      success: true,
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: user.orgId,
        cafeIds: user.cafeIds,
        activeCafeId: user.activeCafeId,
        permissions: {
          canSpendCredits: user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

const refresh = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;

    if (!token) {
      return res.status(401).json({ success: false, message: 'No refresh token' });
    }

    const decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    const tokenHash = hashRefreshToken(token);
    let user;
    let newRefreshToken;

    if (decoded.sid) {
      newRefreshToken = generateRefreshToken(decoded.id, decoded.sid);
      const replacementClaims = jwt.decode(newRefreshToken);
      const now = new Date();
      const rotated = await AuthSession.findOneAndUpdate(
        {
          userId: decoded.id,
          familyId: decoded.sid,
          currentTokenHash: tokenHash,
          revokedAt: null,
          expiresAt: { $gt: now },
        },
        {
          $set: {
            currentTokenHash: hashRefreshToken(newRefreshToken),
            previousTokenHash: tokenHash,
            previousValidUntil: new Date(now.getTime() + REFRESH_REUSE_GRACE_MS),
            graceTokenId: replacementClaims.jti,
            graceTokenIssuedAt: replacementClaims.iat,
            expiresAt: refreshTokenExpiry(newRefreshToken),
            lastUsedAt: now,
          },
        },
        { new: true }
      );
      if (!rotated) {
        // Tabs share the HttpOnly cookie but not the portal's in-memory refresh
        // lock. A near-simultaneous request may therefore carry the token that
        // was just rotated. Briefly reissue the same replacement so response
        // ordering cannot leave the browser holding an already-invalid token.
        const graceSession = await AuthSession.findOne({
          userId: decoded.id,
          familyId: decoded.sid,
          previousTokenHash: tokenHash,
          previousValidUntil: { $gt: now },
          revokedAt: null,
          expiresAt: { $gt: now },
        }).select('+graceTokenId +graceTokenIssuedAt');
        if (
          graceSession?.graceTokenId &&
          Number.isFinite(graceSession.graceTokenIssuedAt)
        ) {
          newRefreshToken = generateRefreshToken(decoded.id, decoded.sid, {
            tokenId: graceSession.graceTokenId,
            issuedAt: graceSession.graceTokenIssuedAt,
            expiresAt: Math.floor(graceSession.expiresAt.getTime() / 1000),
          });
          user = await User.findById(decoded.id);
          if (!user) {
            await AuthSession.updateOne(
              { _id: graceSession._id, revokedAt: null },
              { $set: { revokedAt: new Date(), revokeReason: 'user_missing' } }
            );
            return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
          }
        } else {
          // Outside the narrow concurrency grace, a valid signed token that is
          // no longer current is a replay signal. Revoke the whole family,
          // including its replacement.
          await AuthSession.updateOne(
            { userId: decoded.id, familyId: decoded.sid, revokedAt: null },
            { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } }
          );
          return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
        }
      }
      if (!user) user = await User.findById(decoded.id);
      if (!user && rotated) {
        await AuthSession.updateOne(
          { _id: rotated._id },
          { $set: { revokedAt: new Date(), revokeReason: 'user_missing' } }
        );
        return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
      }
    } else {
      // One-time migration path for refresh tokens issued before session
      // families were introduced.
      user = await User.findOneAndUpdate(
        {
          _id: decoded.id,
          $or: [
            { 'refreshTokens.tokenHash': tokenHash },
            { 'refreshTokens.token': token },
          ],
        },
        {
          $pull: {
            refreshTokens: {
              $or: [{ tokenHash }, { token }],
            },
          },
        },
        { new: true }
      );
      if (!user) {
        return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
      }
      const issued = await issueSession(user);
      newRefreshToken = issued.refreshToken;
    }

    const accessToken = generateAccessToken(
      user._id,
      user.activeCafeId,
      user.role,
      user.orgId,
      user.tokenVersion
    );
    res.cookie('refreshToken', newRefreshToken, COOKIE_OPTIONS);

    return res.status(200).json({ success: true, accessToken });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }
    next(error);
  }
};

const logout = async (req, res, next) => {
  try {
    const token = req.cookies?.refreshToken;

    if (token) {
      let decoded;
      try {
        decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
      } catch (_) {
        decoded = null;
      }
      if (decoded?.sid) {
        await AuthSession.updateOne(
          { userId: decoded.id, familyId: decoded.sid, revokedAt: null },
          { $set: { revokedAt: new Date(), revokeReason: 'logout' } }
        );
      } else {
        const tokenHash = hashRefreshToken(token);
        await User.updateOne(
          {
            $or: [
              { 'refreshTokens.tokenHash': tokenHash },
              { 'refreshTokens.token': token },
            ],
          },
          {
            $pull: {
              refreshTokens: {
                $or: [{ tokenHash }, { token }],
              },
            },
          }
        );
      }
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/auth',
    });

    return res.status(200).json({ success: true, message: 'Logged out' });
  } catch (error) {
    next(error);
  }
};

const FORGOT_PASSWORD_RESPONSE = {
  success: true,
  message: 'If an account exists for that email, a password reset link has been sent.',
};

// Runs after the response, so its duration cannot tell anyone whether the account exists (identity-4).
const deliverPasswordReset = async (normalizedEmail) => {
  const user = await User.findOne({ email: normalizedEmail }).select('_id email name').lean();
  if (!user) return;
  await PasswordResetToken.updateMany(
    { userId: user._id, status: 'pending' },
    { $set: { status: 'revoked', revokedAt: new Date() } }
  );
  const resetToken = generateActionToken();
  const record = await PasswordResetToken.create({
    userId: user._id,
    tokenHash: hashActionToken(resetToken),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
  });
  const result = await emailService.sendPasswordResetEmail({ user, resetToken, expiresAt: record.expiresAt });
  if (!result?.sent) {
    await PasswordResetToken.updateOne(
      { _id: record._id, status: 'pending' },
      { $set: { status: 'revoked', revokedAt: new Date() } }
    );
    console.error('[auth] Password reset email failed:', result?.error?.message || result?.reason || 'unknown error');
  }
};

const forgotPassword = async (req, res, next) => {
  try {
    const normalizedEmail = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
    if (isValidEmail(normalizedEmail)) {
      runAfterResponse('password reset delivery', () => deliverPasswordReset(normalizedEmail));
    }
    return res.status(200).json(FORGOT_PASSWORD_RESPONSE);
  } catch (error) {
    return next(error);
  }
};

const resetPassword = async (req, res, next) => {
  let session;
  try {
    res.set('Cache-Control', 'no-store');
    const token = normalizedActionToken(req.body?.token);
    const newPassword = req.body?.password;
    if (!token) {
      return res.status(404).json({ success: false, message: 'This reset link is invalid or has expired' });
    }
    const newPasswordError = passwordInputError(newPassword);
    if (newPasswordError) {
      return res.status(400).json({ success: false, message: newPasswordError });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const reset = await PasswordResetToken.findOneAndUpdate(
        {
          tokenHash: hashActionToken(token),
          status: 'pending',
          expiresAt: { $gt: new Date() },
        },
        { $set: { status: 'accepting' } },
        { new: true, session }
      );
      if (!reset) {
        const error = new Error('This reset link is invalid or has expired');
        error.statusCode = 404;
        throw error;
      }
      const user = await User.findById(reset.userId).select('+password +refreshTokens').session(session);
      if (!user) {
        const error = new Error('This reset link is invalid or has expired');
        error.statusCode = 404;
        throw error;
      }
      if (await user.comparePassword(newPassword)) {
        const error = new Error('New password must be different from the current password');
        error.statusCode = 400;
        throw error;
      }
      user.password = newPassword;
      user.refreshTokens = [];
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save({ session });
      await AuthSession.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'password_reset' } },
        { session }
      );
      reset.status = 'used';
      reset.usedAt = new Date();
      await reset.save({ session });
      if (user.orgId) {
        await AccessAuditEvent.create([{
          orgId: user.orgId,
          actorUserId: user._id,
          targetUserId: user._id,
          action: 'password.reset',
          targetEmail: user.email,
          requestId: req.id,
        }], { session });
      }
    });

    res.clearCookie('refreshToken', {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/auth',
    });
    return res.status(200).json({
      success: true,
      message: 'Password reset. You can now sign in.',
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    return next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const changePassword = async (req, res, next) => {
  let session;
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string' || !newPassword) {
      return res.status(400).json({ success: false, message: 'Current password and new password are required' });
    }
    const newPasswordError = passwordInputError(newPassword, { label: 'New password' });
    if (newPasswordError) {
      return res.status(400).json({ success: false, message: newPasswordError });
    }
    // bcrypt reads 72 bytes, so an over-long "current password" could match on its prefix. It can never be the real one.
    if (passwordTooLong(currentPassword)) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const user = await User.findById(req.user.id).select('+password +refreshTokens').session(session);
      if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const currentMatches = await user.comparePassword(currentPassword);
      if (!currentMatches) {
        const error = new Error('Current password is incorrect');
        error.statusCode = 401;
        throw error;
      }

      const reusedPassword = await user.comparePassword(newPassword);
      if (reusedPassword) {
        const error = new Error('New password must be different from the current password');
        error.statusCode = 400;
        throw error;
      }

      user.password = newPassword;
      user.refreshTokens = [];
      user.tokenVersion = Number(user.tokenVersion || 0) + 1;
      await user.save({ session });
      await AuthSession.updateMany(
        { userId: user._id, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: 'password_change' } },
        { session }
      );
      await AccessAuditEvent.create([{
        orgId: user.orgId,
        actorUserId: user._id,
        targetUserId: user._id,
        action: 'password.changed',
        targetEmail: user.email,
        requestId: req.id,
      }], { session });
    });

    res.clearCookie('refreshToken', {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/api/auth',
    });

    return res.status(200).json({
      success: true,
      message: 'Password changed. Please sign in again.',
    });
  } catch (error) {
    if (error?.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const me = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password -refreshTokens');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    return res.status(200).json({
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      cafeIds: user.cafeIds,
      activeCafeId: user.activeCafeId,
      emailVerified: user.emailVerified !== false,
      permissions: {
        canSpendCredits: user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  register,
  resendVerification,
  verifyEmail,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  me,
};
