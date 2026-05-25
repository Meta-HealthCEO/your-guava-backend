const Cafe = require('../models/Cafe.model');
const User = require('../models/User.model');
const { normalizeTradingHours, defaultTradingHours } = require('../utils/tradingHours');

// GET /api/cafe/list — all cafes the user can access
const listCafes = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    let cafes;
    if (user.role === 'owner') {
      // Owners see all cafes in their org
      cafes = await Cafe.find({ orgId: user.orgId }).select('name location').lean();
    } else {
      // Managers only see assigned cafes
      cafes = await Cafe.find({ _id: { $in: user.cafeIds } }).select('name location').lean();
    }

    return res.status(200).json({ success: true, cafes });
  } catch (error) {
    next(error);
  }
};

const getMe = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId).lean();
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }
    if (!Array.isArray(cafe.tradingHours) || cafe.tradingHours.length !== 7) {
      cafe.tradingHours = defaultTradingHours();
    }
    return res.status(200).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

const updateMe = async (req, res, next) => {
  try {
    const { name, location, tradingHours } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (location) updates.location = location;
    if (tradingHours !== undefined) {
      updates.tradingHours = normalizeTradingHours(tradingHours);
    }

    const cafe = await Cafe.findByIdAndUpdate(
      req.user.cafeId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }

    return res.status(200).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

module.exports = { listCafes, getMe, updateMe };
