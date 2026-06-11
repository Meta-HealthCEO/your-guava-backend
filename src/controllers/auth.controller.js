const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const emailService = require('../services/email.service');

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

// Max stored refresh tokens per user (roughly one per device, plus rotations)
const MAX_REFRESH_TOKENS = 10;

// Drops expired/invalid tokens so the stored list stays bounded and clean.
const pruneRefreshTokens = (entries = []) =>
  entries.filter((entry) => {
    try {
      jwt.verify(entry.token, process.env.JWT_REFRESH_SECRET);
      return true;
    } catch {
      return false;
    }
  });

const storeRefreshToken = (user, refreshToken) => {
  const pruned = pruneRefreshTokens(user.refreshTokens);
  user.refreshTokens = [...pruned.slice(-(MAX_REFRESH_TOKENS - 1)), { token: refreshToken }];
};

const generateTokens = (userId, cafeId, role, orgId) => {
  const accessToken = jwt.sign(
    {
      id: userId,
      cafeId: cafeId ? cafeId.toString() : null,
      role: role || 'owner',
      orgId: orgId ? orgId.toString() : null,
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
  try {
    const { email, password, name, cafeName, orgName } = req.body;

    if (!email || !password || !name) {
      return res
        .status(400)
        .json({ success: false, message: 'Email, password, and name are required' });
    }

    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Create user first (owner by default)
    const user = await User.create({ email, password, name, role: 'owner' });

    // Create organization
    const org = await Organization.create({
      name: orgName || `${name}'s Organization`,
      ownerId: user._id,
      billingEmail: email,
    });

    // Create first cafe
    const cafe = await Cafe.create({
      name: cafeName || 'My Cafe',
      orgId: org._id,
    });

    // Link user to org and cafe
    user.orgId = org._id;
    user.cafeIds = [cafe._id];
    user.activeCafeId = cafe._id;

    const { accessToken, refreshToken } = generateTokens(user._id, cafe._id, 'owner', org._id);

    storeRefreshToken(user, refreshToken);
    await user.save();

    await emailService.sendWelcomeEmail({ user, org, cafe });

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
    next(error);
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

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const { accessToken, refreshToken } = generateTokens(user._id, user.activeCafeId, user.role, user.orgId);

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

    // Find the user that holds this refresh token
    const user = await User.findOne({ 'refreshTokens.token': token });
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid refresh token' });
    }

    // Verify the token
    jwt.verify(token, process.env.JWT_REFRESH_SECRET);

    // Atomically consume the presented token. The $pull is the race gate:
    // if two requests arrive with the same token, only the first removes it
    // (modifiedCount === 1); the loser is treated as a replay and rejected.
    const consume = await User.updateOne(
      { _id: user._id, 'refreshTokens.token': token },
      { $pull: { refreshTokens: { token } } }
    );
    if (consume.modifiedCount === 0) {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token' });
    }

    const accessToken = jwt.sign(
      {
        id: user._id,
        cafeId: user.activeCafeId ? user.activeCafeId.toString() : null,
        role: user.role || 'owner',
        orgId: user.orgId ? user.orgId.toString() : null,
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
    );

    // Rotate: issue and store a fresh, unique (jti) refresh token, bounded list.
    const newRefreshToken = jwt.sign(
      { id: user._id, jti: crypto.randomUUID() },
      process.env.JWT_REFRESH_SECRET,
      { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d' }
    );
    await User.updateOne(
      { _id: user._id },
      {
        $push: {
          refreshTokens: { $each: [{ token: newRefreshToken }], $slice: -MAX_REFRESH_TOKENS },
        },
      }
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
      // Remove the token from the user's refreshTokens array
      await User.updateOne(
        { 'refreshTokens.token': token },
        { $pull: { refreshTokens: { token } } }
      );
    }

    res.clearCookie('refreshToken', {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
    });

    return res.status(200).json({ success: true, message: 'Logged out' });
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

module.exports = { register, login, refresh, logout, me };
