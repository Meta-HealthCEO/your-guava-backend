const Cafe = require('../models/Cafe.model');
const { checkConnection } = require('../services/yoco.service');

const getMe = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId);
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }
    return res.status(200).json({ success: true, cafe });
  } catch (error) {
    next(error);
  }
};

const updateMe = async (req, res, next) => {
  try {
    const { name, location } = req.body;

    const updates = {};
    if (name) updates.name = name;
    if (location) updates.location = location;

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

const connectYoco = async (req, res, next) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey) {
      return res.status(400).json({ success: false, message: 'Yoco API key is required' });
    }

    const isValid = await checkConnection(apiKey);
    if (!isValid) {
      return res.status(400).json({ success: false, message: 'Invalid Yoco API key' });
    }

    const cafe = await Cafe.findByIdAndUpdate(
      req.user.cafeId,
      { $set: { yocoApiKey: apiKey, yocoConnected: true } },
      { new: true }
    );

    return res.status(200).json({
      success: true,
      message: 'Yoco connected successfully',
      yocoConnected: cafe.yocoConnected,
    });
  } catch (error) {
    next(error);
  }
};

const getYocoStatus = async (req, res, next) => {
  try {
    const cafe = await Cafe.findById(req.user.cafeId).select('yocoConnected lastSyncAt');
    if (!cafe) {
      return res.status(404).json({ success: false, message: 'Cafe not found' });
    }
    return res.status(200).json({
      success: true,
      yocoConnected: cafe.yocoConnected,
      lastSyncAt: cafe.lastSyncAt,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getMe, updateMe, connectYoco, getYocoStatus };
