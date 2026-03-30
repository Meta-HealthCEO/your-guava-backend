const Staff = require('../models/Staff.model');
const LeaveBalance = require('../models/LeaveBalance.model');

// POST /api/staff — Create staff member + leave balance
const create = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { name, email, phone, role, hourlyRate, startDate } = req.body;

    if (!name || hourlyRate == null) {
      return res.status(400).json({ success: false, message: 'name and hourlyRate are required' });
    }

    const staff = await Staff.create({
      cafeId,
      name,
      email,
      phone,
      role,
      hourlyRate,
      startDate: startDate ? new Date(startDate) : undefined,
    });

    // Create default leave balance for new staff member
    await LeaveBalance.create({
      staffId: staff._id,
      cafeId,
    });

    return res.status(201).json({ success: true, staff });
  } catch (error) {
    next(error);
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

    const staff = await Staff.findOneAndUpdate(
      { _id: id, cafeId },
      {
        $set: {
          ...(name !== undefined && { name }),
          ...(email !== undefined && { email }),
          ...(phone !== undefined && { phone }),
          ...(role !== undefined && { role }),
          ...(hourlyRate !== undefined && { hourlyRate }),
          ...(startDate !== undefined && { startDate: new Date(startDate) }),
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
