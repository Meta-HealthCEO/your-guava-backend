const Event = require('../models/Event.model');

const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { from, to } = req.query;

    const filter = { cafeId };

    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) filter.date.$lte = new Date(to);
    } else {
      // Default: show events from today onwards
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      filter.date = { $gte: today };
    }

    const events = await Event.find(filter).sort({ date: 1 }).lean();
    return res.status(200).json({ success: true, events });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { name, date, impact, notes, recurring } = req.body;

    if (!name || !date) {
      return res.status(400).json({ success: false, message: 'name and date are required' });
    }

    const event = await Event.create({
      cafeId,
      name,
      date: new Date(date),
      impact: impact || 'medium',
      notes,
      recurring: recurring || false,
    });

    return res.status(201).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;
    const { name, date, impact, notes, recurring } = req.body;

    const event = await Event.findOneAndUpdate(
      { _id: id, cafeId },
      { $set: { name, date: date ? new Date(date) : undefined, impact, notes, recurring } },
      { new: true, runValidators: true }
    );

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    return res.status(200).json({ success: true, event });
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const event = await Event.findOneAndDelete({ _id: id, cafeId });

    if (!event) {
      return res.status(404).json({ success: false, message: 'Event not found' });
    }

    return res.status(200).json({ success: true, message: 'Event deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, update, remove };
