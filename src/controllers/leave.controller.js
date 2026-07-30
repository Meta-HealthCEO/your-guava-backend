const mongoose = require('mongoose');
const LeaveRequest = require('../models/LeaveRequest.model');
const LeaveBalance = require('../models/LeaveBalance.model');
const Staff = require('../models/Staff.model');

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MAX_LEAVE_SPAN_DAYS = 366;
const MAX_CALENDAR_SPAN_DAYS = 93;
const LEAVE_TYPES = new Set(['annual', 'sick', 'family', 'unpaid']);

const parseDateOnly = (value) => {
  const match = String(value || '').match(DATE_ONLY_RE);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
    ? date
    : null;
};

const formatDateOnly = (date) => new Date(date).toISOString().slice(0, 10);
const inclusiveDays = (start, end) => Math.floor((end - start) / 86400000) + 1;

/**
 * Count weekdays between two dates (inclusive).
 */
function countWeekdays(start, end) {
  const totalDays = inclusiveDays(start, end);
  const completeWeeks = Math.floor(totalDays / 7);
  let count = completeWeeks * 5;
  const remainingDays = totalDays % 7;
  for (let index = 0; index < remainingDays; index++) {
    const day = (start.getUTCDay() + index) % 7;
    if (day !== 0 && day !== 6) count++;
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
    if (!LEAVE_TYPES.has(type)) {
      return res.status(400).json({
        success: false,
        message: 'type must be annual, sick, family, or unpaid',
      });
    }

    const start = parseDateOnly(startDate);
    const end = parseDateOnly(endDate);

    if (!start || !end || end < start) {
      return res.status(400).json({ success: false, message: 'startDate and endDate must be a valid YYYY-MM-DD range' });
    }
    if (inclusiveDays(start, end) > MAX_LEAVE_SPAN_DAYS) {
      return res.status(400).json({ success: false, message: `Leave periods cannot exceed ${MAX_LEAVE_SPAN_DAYS} days` });
    }

    const days = countWeekdays(start, end);
    if (days === 0) {
      return res.status(400).json({ success: false, message: 'Leave period must include at least one weekday' });
    }

    const staffMember = await Staff.findOne({ _id: staffId, cafeId }).select('_id').lean();
    if (!staffMember) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
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

    return res.status(200).json({ success: true, leaveRequests, requests: leaveRequests });
  } catch (error) {
    next(error);
  }
};

// PUT /api/leave/:id/approve — Approve leave request
const approve = async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;
    let leaveRequest;

    await session.withTransaction(async () => {
      leaveRequest = await LeaveRequest.findOne({ _id: id, cafeId }).session(session);
      if (!leaveRequest) {
        const error = new Error('Leave request not found');
        error.statusCode = 404;
        throw error;
      }
      if (leaveRequest.status !== 'pending') {
        const error = new Error(`Leave request is already ${leaveRequest.status}`);
        error.statusCode = 409;
        throw error;
      }

      if (leaveRequest.type !== 'unpaid') {
        const totalPath = `${leaveRequest.type}.total`;
        const usedPath = `${leaveRequest.type}.used`;
        const balance = await LeaveBalance.findOneAndUpdate(
          {
            staffId: leaveRequest.staffId,
            cafeId,
            $expr: {
              $gte: [
                { $subtract: [`$${totalPath}`, `$${usedPath}`] },
                leaveRequest.days,
              ],
            },
          },
          { $inc: { [usedPath]: leaveRequest.days } },
          { new: true, session }
        );
        if (!balance) {
          const exists = await LeaveBalance.exists({ staffId: leaveRequest.staffId, cafeId }).session(session);
          const error = new Error(
            exists ? `Insufficient ${leaveRequest.type} leave balance to approve` : 'Leave balance not found'
          );
          error.statusCode = exists ? 400 : 404;
          throw error;
        }
      }

      leaveRequest.status = 'approved';
      leaveRequest.approvedBy = req.user.id;
      leaveRequest.approvedAt = new Date();
      await leaveRequest.save({ session });
    });

    return res.status(200).json({ success: true, leaveRequest });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
};

// PUT /api/leave/:id/reject — Reject leave request
const reject = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const leaveRequest = await LeaveRequest.findOneAndUpdate(
      { _id: id, cafeId, status: 'pending' },
      { $set: { status: 'rejected' } },
      { new: true }
    );
    if (!leaveRequest) {
      const existing = await LeaveRequest.findOne({ _id: id, cafeId }).select('status').lean();
      if (!existing) return res.status(404).json({ success: false, message: 'Leave request not found' });
      return res.status(409).json({ success: false, message: `Leave request is already ${existing.status}` });
    }

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
      startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
    } else {
      startDate = parseDateOnly(startDate);
      endDate = parseDateOnly(endDate);
      if (!startDate || !endDate || endDate < startDate) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate must be a valid YYYY-MM-DD range',
        });
      }
    }
    if (inclusiveDays(startDate, endDate) > MAX_CALENDAR_SPAN_DAYS) {
      return res.status(400).json({
        success: false,
        message: `Calendar ranges cannot exceed ${MAX_CALENDAR_SPAN_DAYS} days`,
      });
    }
    endDate.setUTCHours(23, 59, 59, 999);

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
      current.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(0, 0, 0, 0);

      while (current <= end) {
        const day = current.getUTCDay();
        if (day !== 0 && day !== 6) {
          const key = formatDateOnly(current);
          if (!calendar[key]) {
            calendar[key] = { date: key, staff: [] };
          }
          calendar[key].staff.push({
            name: lr.staffId ? lr.staffId.name : 'Unknown',
            type: lr.type,
          });
        }
        current.setUTCDate(current.getUTCDate() + 1);
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
    const activeBalances = balances
      .filter((b) => b.staffId && b.staffId.isActive)
      .map((balance) => ({
        ...balance,
        staff: balance.staffId,
        staffId: String(balance.staffId._id),
      }));

    return res.status(200).json({ success: true, balances: activeBalances });
  } catch (error) {
    next(error);
  }
};

module.exports = { create, list, approve, reject, getCalendar, getBalances };
