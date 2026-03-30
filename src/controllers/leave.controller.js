const LeaveRequest = require('../models/LeaveRequest.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const Staff = require('../models/Staff.model');

/**
 * Count weekdays between two dates (inclusive).
 */
function countWeekdays(start, end) {
  let count = 0;
  const current = new Date(start);
  current.setHours(0, 0, 0, 0);
  const endDate = new Date(end);
  endDate.setHours(0, 0, 0, 0);

  while (current <= endDate) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }
  return count;
}

// POST /api/leave — Submit leave request
const create = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { staffId, type, startDate, endDate, reason } = req.body;

    if (!staffId || !type || !startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'staffId, type, startDate, and endDate are required',
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (end < start) {
      return res.status(400).json({ success: false, message: 'endDate must be on or after startDate' });
    }

    const days = countWeekdays(start, end);
    if (days === 0) {
      return res.status(400).json({ success: false, message: 'Leave period must include at least one weekday' });
    }

    // Check leave balance (skip for unpaid leave)
    if (type !== 'unpaid') {
      const balance = await LeaveBalance.findOne({ staffId, cafeId });
      if (!balance) {
        return res.status(404).json({ success: false, message: 'Leave balance not found for staff member' });
      }

      const remaining = balance[type].total - balance[type].used;
      if (days > remaining) {
        return res.status(400).json({
          success: false,
          message: `Insufficient ${type} leave balance. ${remaining} day(s) remaining, ${days} requested.`,
        });
      }
    }

    const leaveRequest = await LeaveRequest.create({
      staffId,
      cafeId,
      type,
      startDate: start,
      endDate: end,
      days,
      reason,
    });

    return res.status(201).json({ success: true, leaveRequest });
  } catch (error) {
    next(error);
  }
};

// GET /api/leave — List all leave requests
const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { status, staffId } = req.query;

    const filter = { cafeId };
    if (status) filter.status = status;
    if (staffId) filter.staffId = staffId;

    const leaveRequests = await LeaveRequest.find(filter)
      .populate('staffId', 'name role')
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ success: true, leaveRequests });
  } catch (error) {
    next(error);
  }
};

// PUT /api/leave/:id/approve — Approve leave request
const approve = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const leaveRequest = await LeaveRequest.findOne({ _id: id, cafeId });
    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Leave request is already ${leaveRequest.status}`,
      });
    }

    // Deduct from balance (skip for unpaid)
    if (leaveRequest.type !== 'unpaid') {
      const balance = await LeaveBalance.findOne({ staffId: leaveRequest.staffId, cafeId });
      if (!balance) {
        return res.status(404).json({ success: false, message: 'Leave balance not found' });
      }

      const remaining = balance[leaveRequest.type].total - balance[leaveRequest.type].used;
      if (leaveRequest.days > remaining) {
        return res.status(400).json({
          success: false,
          message: `Insufficient ${leaveRequest.type} leave balance to approve`,
        });
      }

      balance[leaveRequest.type].used += leaveRequest.days;
      await balance.save();
    }

    leaveRequest.status = 'approved';
    leaveRequest.approvedBy = req.user.id;
    leaveRequest.approvedAt = new Date();
    await leaveRequest.save();

    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    next(error);
  }
};

// PUT /api/leave/:id/reject — Reject leave request
const reject = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const leaveRequest = await LeaveRequest.findOne({ _id: id, cafeId });
    if (!leaveRequest) {
      return res.status(404).json({ success: false, message: 'Leave request not found' });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: `Leave request is already ${leaveRequest.status}`,
      });
    }

    leaveRequest.status = 'rejected';
    await leaveRequest.save();

    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    next(error);
  }
};

// GET /api/leave/calendar — Approved leave for calendar view
const getCalendar = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      // Default to current month
      const now = new Date();
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    } else {
      startDate = new Date(startDate);
      endDate = new Date(endDate);
    }
    endDate.setHours(23, 59, 59, 999);

    const leaveRequests = await LeaveRequest.find({
      cafeId,
      status: 'approved',
      startDate: { $lte: endDate },
      endDate: { $gte: startDate },
    })
      .populate('staffId', 'name')
      .lean();

    // Build a map of date -> staff on leave
    const calendar = {};
    for (const lr of leaveRequests) {
      const current = new Date(Math.max(lr.startDate.getTime(), startDate.getTime()));
      const end = new Date(Math.min(lr.endDate.getTime(), endDate.getTime()));
      current.setHours(0, 0, 0, 0);
      end.setHours(0, 0, 0, 0);

      while (current <= end) {
        const day = current.getDay();
        if (day !== 0 && day !== 6) {
          const key = current.toISOString().split('T')[0];
          if (!calendar[key]) {
            calendar[key] = { date: key, staff: [] };
          }
          calendar[key].staff.push({
            name: lr.staffId ? lr.staffId.name : 'Unknown',
            type: lr.type,
          });
        }
        current.setDate(current.getDate() + 1);
      }
    }

    return res.status(200).json({ success: true, calendar: Object.values(calendar) });
  } catch (error) {
    next(error);
  }
};

// GET /api/leave/balances — All staff leave balances for the cafe
const getBalances = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;

    const balances = await LeaveBalance.find({ cafeId })
      .populate('staffId', 'name role isActive')
      .lean();

    // Only return balances for active staff
    const activeBalances = balances.filter((b) => b.staffId && b.staffId.isActive);

    return res.status(200).json({ success: true, balances: activeBalances });
  } catch (error) {
    next(error);
  }
};

module.exports = { create, list, approve, reject, getCalendar, getBalances };
