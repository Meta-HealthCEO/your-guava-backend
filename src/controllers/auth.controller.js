const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const emailService = require('../services/email.service');

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/api/auth',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// Max stored refresh tokens per user (roughly one per device, plus rotations)
const MAX_REFRESH_TOKENS = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PASSWORD_BYTES = 72;

const passwordTooLong = (password) =>
  Buffer.byteLength(String(password), 'utf8') > MAX_PASSWORD_BYTES;

const hashRefreshToken = (token) =>
  crypto.createHash('sha256').update(String(token)).digest('hex');

const refreshTokenExpiry = (token) => {
  const decoded = jwt.decode(token);
  return decoded?.exp ? new Date(decoded.exp * 1000) : new Date(Date.now() + COOKIE_OPTIONS.maxAge);
};

// New refresh tokens are stored as one-way digests. A database read can no
// longer be turned directly into an authenticated browser session.
const refreshTokenEntry = (token) => ({
  tokenHash: hashRefreshToken(token),
  expiresAt: refreshTokenExpiry(token),
});

const pruneRefreshTokens = (entries = []) => {
  const now = Date.now();
  return entries.filter((entry) => !entry.expiresAt || new Date(entry.expiresAt).getTime() > now);
};

const storeRefreshToken = (user, refreshToken) => {
  const pruned = pruneRefreshTokens(user.refreshTokens);
  user.refreshTokens = [
    ...pruned.slice(-(MAX_REFRESH_TOKENS - 1)),
    refreshTokenEntry(refreshToken),
  ];
};

const generateTokens = (userId, cafeId, role, orgId, tokenVersion = 0) => {
  const accessToken = jwt.sign(
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

  // jti makes every refresh token unique even when issued in the same second,
  // so rotation never re-creates a token byte-identical to the one it consumed.
  const refreshToken = jwt.sign(
    { id: userId, jti: crypto.randomUUID() },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
  );

  return { accessToken, refreshToken };
};

const register = async (req, res, next) => {
  let session;
  try {
    const { email, password, name, cafeName, orgName } = req.body;

    if (!email || !password || !name) {
      return res
        .status(400)
        .json({ success: false, message: 'Email, password, and name are required' });
    }

    if (String(password).length < 8) {
      return res
        .status(400)
        .json({ success: false, message: 'Password must be at least 8 characters' });
    }
    if (passwordTooLong(password)) {
      return res
        .status(400)
        .json({ success: false, message: `Password cannot exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes` });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const normalizedName = String(name).trim();
    const suppliedCafeName = cafeName == null ? '' : String(cafeName).trim();
    const suppliedOrgName = orgName == null ? '' : String(orgName).trim();
    const normalizedCafeName = suppliedCafeName || 'My Cafe';
    const normalizedOrgName =
      suppliedOrgName || `${normalizedName}'s Organization`.slice(0, 120);
    if (!EMAIL_RE.test(normalizedEmail) || normalizedEmail.length > 254) {
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

    let user;
    let org;
    let cafe;
    let accessToken;
    let refreshToken;

    session = await mongoose.startSession();
    await session.withTransaction(async () => {
      const existingUser = await User.findOne({ email: normalizedEmail }).session(session);
      if (existingUser) {
        const conflict = new Error('Email already registered');
        conflict.statusCode = 409;
        throw conflict;
      }

      [user] = await User.create(
        [{ email: normalizedEmail, password, name: normalizedName, role: 'owner' }],
        { session }
      );
      [org] = await Organization.create(
        [{
          name: normalizedOrgName,
          ownerId: user._id,
          billingEmail: normalizedEmail,
        }],
        { session }
      );
      [cafe] = await Cafe.create(
        [{ name: normalizedCafeName, orgId: org._id }],
        { session }
      );

      user.orgId = org._id;
      user.cafeIds = [cafe._id];
      user.activeCafeId = cafe._id;

      ({ accessToken, refreshToken } = generateTokens(
        user._id,
        cafe._id,
        'owner',
        org._id,
        user.tokenVersion
      ));
      storeRefreshToken(user, refreshToken);
      await user.save({ session });
    });

    try {
      const emailResult = await emailService.sendWelcomeEmail({ user, org, cafe });
      if (emailResult?.sent === false) {
        console.warn(
          '[auth] Welcome email was not sent after registration:',
          emailResult.error?.message || emailResult.error || 'unknown error'
        );
      }
    } catch (emailError) {
      console.warn(
        '[auth] Welcome email failed after registration:',
        emailError?.message || emailError || 'unknown error'
      );
    }

    const cookieOptions = {
      ...COOKIE_OPTIONS,
      secure: process.env.NODE_ENV === 'production',
    };

    res.cookie('refreshToken', refreshToken, cookieOptions);

    return res.status(201).json({
      success: true,
      accessToken,
      user: {
        id: user._id,
        email: user.email,
        name: user.name,
        role: user.role,
        orgId: org._id,
        cafeIds: user.cafeIds,
        activeCafeId: cafe._id,
      },
    });
  } catch (error) {
    if (error?.code === 11000 && error?.keyPattern?.email) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }
    next(error);
  } finally {
    if (session) await session.endSession();
  }
};

const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, message: 'Email and password are required' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    if (!EMAIL_RE.test(normalizedEmail) || passwordTooLong(password)) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = await User.findOne({ email: normalizedEmail }).select('+password +refreshTokens');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const { accessToken, refreshToken } = generateTokens(
      user._id,
      user.activeCafeId,
      user.role,
      user.orgId,
      user.tokenVersion
    );

    storeRefreshToken(user, refreshToken);
    await user.save();

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
    const newRefreshToken = jwt.sign(
      { id: decoded.id, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );
    const newEntry = refreshTokenEntry(newRefreshToken);

    // Consume the old digest and append the replacement in one database write.
    // The query predicate is the replay gate: only one concurrent request can
    // match the presented token.
    const user = await User.findOneAndUpdate(
      {
        _id: decoded.id,
        $or: [
          { 'refreshTokens.tokenHash': tokenHash },
          { 'refreshTokens.token': token },
        ],
      },
      [
        {
          $set: {
            refreshTokens: {
              $slice: [
                {
                  $concatArrays: [
                    {
                      $filter: {
                        input: { $ifNull: ['$refreshTokens', []] },
                        as: 'entry',
                        cond: {
                          $and: [
                            {
                              $ne: [
                                { $ifNull: ['$$entry.tokenHash', ''] },
                                tokenHash,
                              ],
                            },
                            {
                              $ne: [
                                { $ifNull: ['$$entry.token', ''] },
                                token,
                              ],
                            },
                          ],
                        },
                      },
                    },
                    [newEntry],
                  ],
                },
                -MAX_REFRESH_TOKENS,
              ],
            },
          },
        },
      ],
      { new: true }
    );
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const accessToken = jwt.sign(
      {
        id: user._id,
        cafeId: user.activeCafeId ? user.activeCafeId.toString() : null,
        role: user.role || 'owner',
        orgId: user.orgId ? user.orgId.toString() : null,
        tokenVersion: Number(user.tokenVersion || 0),
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
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

const changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ success: false, message: 'Current password and new password are required' });
    }

    if (String(newPassword).length < 8) {
      return res
        .status(400)
        .json({ success: false, message: 'New password must be at least 8 characters' });
    }
    if (passwordTooLong(newPassword)) {
      return res
        .status(400)
        .json({ success: false, message: `New password cannot exceed ${MAX_PASSWORD_BYTES} UTF-8 bytes` });
    }

    const user = await User.findById(req.user.id).select('+password +refreshTokens');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const currentMatches = await user.comparePassword(currentPassword);
    if (!currentMatches) {
      return res.status(401).json({ success: false, message: 'Current password is incorrect' });
    }

    const reusedPassword = await user.comparePassword(newPassword);
    if (reusedPassword) {
      return res
        .status(400)
        .json({ success: false, message: 'New password must be different from the current password' });
    }

    user.password = newPassword;
    user.refreshTokens = [];
    user.tokenVersion = Number(user.tokenVersion || 0) + 1;
    await user.save();

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
    next(error);
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
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { register, login, refresh, logout, changePassword, me };
