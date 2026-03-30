const Cafe = require('../models/Cafe.model');

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

module.exports = { getMe, updateMe };
