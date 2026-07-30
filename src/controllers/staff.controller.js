const mongoose = require('mongoose');
const Staff = require('../models/Staff.model');
const LeaveBalance = require('../models/LeaveBalance.model');

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const parseDateOnly = (value) => {
  if (value == null || value === '') return undefined;
  const match = String(value).match(DATE_ONLY_RE);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
    ? date
    : null;
};

// POST /api/staff — Create staff member + leave balance
const create = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = req.user.cafeId;
    const { name, email, phone, role, hourlyRate, startDate } = req.body;
    const parsedRate = Number(hourlyRate);
    const parsedStartDate = parseDateOnly(startDate);

    if (!String(name || '').trim() || hourlyRate == null) {
      return res.status(400).json({ success: false, message: 'name and hourlyRate are required' });
    }
    if (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 10000) {
      return res.status(400).json({ success: false, message: 'hourlyRate must be between 0 and 10000' });
    }
    if (startDate && !parsedStartDate) {
      return res.status(400).json({ success: false, message: 'startDate must use YYYY-MM-DD' });
    }

    let staff;
    await session.withTransaction(async () => {
      [staff] = await Staff.create([{
        cafeId,
        name: String(name).trim(),
        email,
        phone,
        role,
        hourlyRate: parsedRate,
        startDate: parsedStartDate,
      }], { session });
      await LeaveBalance.create([{ staffId: staff._id, cafeId }], { session });
    });

    return res.status(201).json({ success: true, staff });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
};

// GET /api/staff — List all active staff for cafe with leave balances
const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;

    const staff = await Staff.find({ cafeId, isActive: true }).sort({ name: 1 }).lean();

    // Attach leave balances
    const staffIds = staff.map((s) => s._id);
    const balances = await LeaveBalance.find({ staffId: { $in: staffIds } }).lean();
    const balanceMap = {};
    for (const b of balances) {
      balanceMap[b.staffId.toString()] = b;
    }

    const staffWithBalances = staff.map((s) => ({
      ...s,
      leaveBalance: balanceMap[s._id.toString()] || null,
    }));

    return res.status(200).json({ success: true, staff: staffWithBalances });
  } catch (error) {
    next(error);
  }
};

// GET /api/staff/:id — Get single staff member with leave balance
const getOne = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const staff = await Staff.findOne({ _id: id, cafeId }).lean();

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    const leaveBalance = await LeaveBalance.findOne({ staffId: staff._id }).lean();

    return res.status(200).json({ success: true, staff: { ...staff, leaveBalance } });
  } catch (error) {
    next(error);
  }
};

// PUT /api/staff/:id — Update staff details
const update = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;
    const { name, email, phone, role, hourlyRate, startDate, isActive } = req.body;
    const parsedStartDate = startDate !== undefined ? parseDateOnly(startDate) : undefined;
    const parsedRate = hourlyRate !== undefined ? Number(hourlyRate) : undefined;

    if (startDate !== undefined && !parsedStartDate) {
      return res.status(400).json({ success: false, message: 'startDate must use YYYY-MM-DD' });
    }
    if (hourlyRate !== undefined && (!Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 10000)) {
      return res.status(400).json({ success: false, message: 'hourlyRate must be between 0 and 10000' });
    }

    const staff = await Staff.findOneAndUpdate(
      { _id: id, cafeId },
      {
        $set: {
          ...(name !== undefined && { name: String(name).trim() }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(role !== undefined && { role }),
          ...(hourlyRate !== undefined && { hourlyRate: parsedRate }),
          ...(startDate !== undefined && { startDate: parsedStartDate }),
          ...(isActive !== undefined && { isActive }),
        },
      },
      { new: true, runValidators: true }
    );

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.status(200).json({ success: true, staff });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/staff/:id — Soft delete (set isActive: false)
const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const staff = await Staff.findOneAndUpdate(
      { _id: id, cafeId },
      { $set: { isActive: false } },
      { new: true }
    );

    if (!staff) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    return res.status(200).json({ success: true, message: 'Staff member deactivated' });
  } catch (error) {
    next(error);
  }
};

module.exports = { create, list, getOne, update, remove };
