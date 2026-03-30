const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
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

  const refreshToken = jwt.sign(
    { id: userId },
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

    user.refreshTokens.push({ token: refreshToken });
    await user.save();

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

    user.refreshTokens.push({ token: refreshToken });
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
