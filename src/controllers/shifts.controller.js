const Shift = require('../models/Shift.model');
const Staff = require('../models/Staff.model');

const WEEKLY_HOUR_THRESHOLD = 45; // South African BCEA law
const MAX_SHIFT_RANGE_DAYS = 93;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
 * Calculate hours between two HH:MM time strings.
 */
function calcHours(startTime, endTime) {
  if (!TIME_RE.test(String(startTime || '')) || !TIME_RE.test(String(endTime || ''))) {
    return NaN;
  }
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return ((eh * 60 + em) - (sh * 60 + sm)) / 60;
}

/**
 * Get Monday 00:00 and Sunday 23:59 for the week containing the given date.
 */
function getWeekBounds(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  monday.setUTCHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  sunday.setUTCHours(23, 59, 59, 999);

  return { monday, sunday };
}

/**
 * Get total hours for a staff member in the week containing the given date,
 * excluding a specific shift id (for updates).
 */
/**
 * Returns true if the staff member exists and belongs to the given cafe.
 * Prevents attaching shifts/leave to another tenant's staff.
 */
async function staffBelongsToCafe(staffId, cafeId) {
  const staff = await Staff.findOne({ _id: staffId, cafeId }).select('_id').lean();
  return Boolean(staff);
}

async function getWeeklyHours(cafeId, staffId, date, excludeShiftId = null) {
  const { monday, sunday } = getWeekBounds(date);
  const filter = {
    cafeId,
    staffId,
    date: { $gte: monday, $lte: sunday },
    status: { $ne: 'cancelled' },
  };
  if (excludeShiftId) {
    filter._id = { $ne: excludeShiftId };
  }
  const shifts = await Shift.find(filter).lean();
  return shifts.reduce((sum, s) => sum + (s.hoursWorked || 0), 0);
}

// POST /api/shifts — Create a shift
const create = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { staffId, date, startTime, endTime, status, notes } = req.body;
    const shiftDate = parseDateOnly(date);

    if (!staffId || !date || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'staffId, date, startTime, and endTime are required',
      });
    }
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: 'date must use YYYY-MM-DD' });
    }

    const hoursWorked = calcHours(startTime, endTime);
    if (!Number.isFinite(hoursWorked) || hoursWorked <= 0 || hoursWorked > 24) {
      return res.status(400).json({
        success: false,
        message: 'endTime must be after startTime and both times must use HH:MM',
      });
    }

    if (!(await staffBelongsToCafe(staffId, cafeId))) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    // Check if weekly total exceeds 45hrs — auto-flag overtime
    const existingWeeklyHours = await getWeeklyHours(cafeId, staffId, shiftDate);
    const regularHours = Math.min(hoursWorked, Math.max(0, WEEKLY_HOUR_THRESHOLD - existingWeeklyHours));
    const overtimeHours = Math.max(0, hoursWorked - regularHours);
    const type = overtimeHours > 0 ? 'overtime' : 'regular';

    const shift = await Shift.create({
      cafeId,
      staffId,
      date: shiftDate,
      startTime,
      endTime,
      hoursWorked,
      regularHours,
      overtimeHours,
      type,
      status,
      notes,
    });

    return res.status(201).json({ success: true, shift });
  } catch (error) {
    next(error);
  }
};

// GET /api/shifts — Get shifts for a date range
const list = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    let { startDate, endDate } = req.query;

    // Default to current week Mon-Sun
    if (!startDate || !endDate) {
      const { monday, sunday } = getWeekBounds(new Date());
      startDate = monday;
      endDate = sunday;
    } else {
      startDate = parseDateOnly(startDate);
      endDate = parseDateOnly(endDate);
      if (!startDate || !endDate || endDate < startDate) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate must be a valid YYYY-MM-DD range',
        });
      }
      if (inclusiveDays(startDate, endDate) > MAX_SHIFT_RANGE_DAYS) {
        return res.status(400).json({
          success: false,
          message: `Shift ranges cannot exceed ${MAX_SHIFT_RANGE_DAYS} days`,
        });
      }
      endDate.setUTCHours(23, 59, 59, 999);
    }

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: startDate, $lte: endDate },
    })
      .populate('staffId', 'name role')
      .sort({ date: 1, startTime: 1 })
      .lean();

    return res.status(200).json({ success: true, shifts });
  } catch (error) {
    next(error);
  }
};

// GET /api/shifts/week — Current week's roster grouped by day
const getWeek = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { monday, sunday } = getWeekBounds(new Date());

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: monday, $lte: sunday },
      status: { $ne: 'cancelled' },
    })
      .populate('staffId', 'name role hourlyRate')
      .sort({ date: 1, startTime: 1 })
      .lean();

    // Group by day
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    const roster = {};
    for (let i = 0; i < 7; i++) {
      const dayDate = new Date(monday);
      dayDate.setUTCDate(monday.getUTCDate() + i);
      const key = formatDateOnly(dayDate);
      roster[key] = { day: days[i], date: key, shifts: [] };
    }

    for (const shift of shifts) {
      const key = formatDateOnly(shift.date);
      if (roster[key]) {
        roster[key].shifts.push(shift);
      }
    }

    return res.status(200).json({ success: true, roster: Object.values(roster) });
  } catch (error) {
    next(error);
  }
};

// GET /api/shifts/summary — Weekly hours summary per staff member
const getSummary = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      const { monday, sunday } = getWeekBounds(new Date());
      startDate = monday;
      endDate = sunday;
    } else {
      startDate = parseDateOnly(startDate);
      endDate = parseDateOnly(endDate);
      if (!startDate || !endDate || endDate < startDate) {
        return res.status(400).json({
          success: false,
          message: 'startDate and endDate must be a valid YYYY-MM-DD range',
        });
      }
      if (inclusiveDays(startDate, endDate) > MAX_SHIFT_RANGE_DAYS) {
        return res.status(400).json({
          success: false,
          message: `Summary ranges cannot exceed ${MAX_SHIFT_RANGE_DAYS} days`,
        });
      }
      endDate.setUTCHours(23, 59, 59, 999);
    }

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: startDate, $lte: endDate },
      status: { $ne: 'cancelled' },
    })
      .populate('staffId', 'name hourlyRate')
      .sort({ staffId: 1, date: 1, startTime: 1 })
      .lean();

    // Aggregate by staff
    const staffMap = {};
    const weeklyHours = {};
    for (const shift of shifts) {
      if (!shift.staffId) continue;
      const sid = shift.staffId._id.toString();
      if (!staffMap[sid]) {
        staffMap[sid] = {
          staffId: sid,
          staffName: shift.staffId.name,
          hourlyRate: shift.staffId.hourlyRate,
          totalHours: 0,
          regularHours: 0,
          overtimeHours: 0,
        };
      }
      const hours = Number(shift.hoursWorked || 0);
      const weekKey = `${sid}:${formatDateOnly(getWeekBounds(shift.date).monday)}`;
      const hoursBeforeShift = weeklyHours[weekKey] || 0;
      const regularHours = Math.min(hours, Math.max(0, WEEKLY_HOUR_THRESHOLD - hoursBeforeShift));
      const overtimeHours = Math.max(0, hours - regularHours);
      weeklyHours[weekKey] = hoursBeforeShift + hours;
      staffMap[sid].totalHours += hours;
      staffMap[sid].regularHours += regularHours;
      staffMap[sid].overtimeHours += overtimeHours;
    }

    const summary = Object.values(staffMap).map((s) => ({
      ...s,
      totalHours: Math.round(s.totalHours * 100) / 100,
      regularHours: Math.round(s.regularHours * 100) / 100,
      overtimeHours: Math.round(s.overtimeHours * 100) / 100,
      estimatedPay:
        Math.round(
          (s.regularHours * s.hourlyRate + s.overtimeHours * s.hourlyRate * 1.5) * 100
        ) / 100,
      overThreshold: s.totalHours > WEEKLY_HOUR_THRESHOLD,
    }));

    return res.status(200).json({ success: true, summary, summaries: summary });
  } catch (error) {
    next(error);
  }
};

// PUT /api/shifts/:id — Update shift
const update = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;
    const { staffId, date, startTime, endTime, status, notes } = req.body;

    const existing = await Shift.findOne({ _id: id, cafeId });
    if (!existing) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    const newStartTime = startTime || existing.startTime;
    const newEndTime = endTime || existing.endTime;
    const newDate = date ? parseDateOnly(date) : existing.date;
    const newStaffId = staffId || existing.staffId;

    if (date && !newDate) {
      return res.status(400).json({ success: false, message: 'date must use YYYY-MM-DD' });
    }
    const hoursWorked = calcHours(newStartTime, newEndTime);
    if (!Number.isFinite(hoursWorked) || hoursWorked <= 0 || hoursWorked > 24) {
      return res.status(400).json({
        success: false,
        message: 'endTime must be after startTime and both times must use HH:MM',
      });
    }

    if (staffId && !(await staffBelongsToCafe(staffId, cafeId))) {
      return res.status(404).json({ success: false, message: 'Staff member not found' });
    }

    // Re-check overtime threshold
    const existingWeeklyHours = await getWeeklyHours(cafeId, newStaffId, newDate, existing._id);
    const regularHours = Math.min(hoursWorked, Math.max(0, WEEKLY_HOUR_THRESHOLD - existingWeeklyHours));
    const overtimeHours = Math.max(0, hoursWorked - regularHours);
    const type = overtimeHours > 0 ? 'overtime' : 'regular';

    const shift = await Shift.findOneAndUpdate(
      { _id: id, cafeId },
      {
        $set: {
          ...(staffId !== undefined && { staffId }),
          ...(date !== undefined && { date: newDate }),
          ...(startTime !== undefined && { startTime }),
          ...(endTime !== undefined && { endTime }),
          ...(status !== undefined && { status }),
          ...(notes !== undefined && { notes }),
          hoursWorked,
          regularHours,
          overtimeHours,
          type,
        },
      },
      { new: true, runValidators: true }
    );

    return res.status(200).json({ success: true, shift });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/shifts/:id — Delete shift
const remove = async (req, res, next) => {
  try {
    const cafeId = req.user.cafeId;
    const { id } = req.params;

    const shift = await Shift.findOneAndDelete({ _id: id, cafeId });

    if (!shift) {
      return res.status(404).json({ success: false, message: 'Shift not found' });
    }

    return res.status(200).json({ success: true, message: 'Shift deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { create, list, getWeek, getSummary, update, remove };
