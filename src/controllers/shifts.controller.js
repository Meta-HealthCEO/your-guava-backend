const Shift = require('../models/Shift.model');
const Staff = require('../models/Staff.model');

const WEEKLY_HOUR_THRESHOLD = 45; // South African BCEA law

/**
 * Calculate hours between two HH:MM time strings.
 */
function calcHours(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return ((eh * 60 + em) - (sh * 60 + sm)) / 60;
}

/**
 * Get Monday 00:00 and Sunday 23:59 for the week containing the given date.
 */
function getWeekBounds(date) {
  const d = new Date(date);
  const day = d.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);

  return { monday, sunday };
}

/**
 * Get total hours for a staff member in the week containing the given date,
 * excluding a specific shift id (for updates).
 */
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

    if (!staffId || !date || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: 'staffId, date, startTime, and endTime are required',
      });
    }

    const hoursWorked = calcHours(startTime, endTime);
    if (hoursWorked <= 0) {
      return res.status(400).json({ success: false, message: 'endTime must be after startTime' });
    }

    // Check if weekly total exceeds 45hrs — auto-flag overtime
    const existingWeeklyHours = await getWeeklyHours(cafeId, staffId, date);
    const type = existingWeeklyHours + hoursWorked > WEEKLY_HOUR_THRESHOLD ? 'overtime' : 'regular';

    const shift = await Shift.create({
      cafeId,
      staffId,
      date: new Date(date),
      startTime,
      endTime,
      hoursWorked,
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
      startDate = new Date(startDate);
      endDate = new Date(endDate);
      endDate.setHours(23, 59, 59, 999);
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
      dayDate.setDate(monday.getDate() + i);
      const key = dayDate.toISOString().split('T')[0];
      roster[key] = { day: days[i], date: key, shifts: [] };
    }

    for (const shift of shifts) {
      const key = new Date(shift.date).toISOString().split('T')[0];
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
      startDate = new Date(startDate);
      endDate = new Date(endDate);
      endDate.setHours(23, 59, 59, 999);
    }

    const shifts = await Shift.find({
      cafeId,
      date: { $gte: startDate, $lte: endDate },
      status: { $ne: 'cancelled' },
    })
      .populate('staffId', 'name hourlyRate')
      .lean();

    // Aggregate by staff
    const staffMap = {};
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
      const hours = shift.hoursWorked || 0;
      staffMap[sid].totalHours += hours;
      if (shift.type === 'overtime') {
        staffMap[sid].overtimeHours += hours;
      } else {
        staffMap[sid].regularHours += hours;
      }
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

    return res.status(200).json({ success: true, summary });
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
    const newDate = date ? new Date(date) : existing.date;
    const newStaffId = staffId || existing.staffId;

    const hoursWorked = calcHours(newStartTime, newEndTime);
    if (hoursWorked <= 0) {
      return res.status(400).json({ success: false, message: 'endTime must be after startTime' });
    }

    // Re-check overtime threshold
    const existingWeeklyHours = await getWeeklyHours(cafeId, newStaffId, newDate, existing._id);
    const type = existingWeeklyHours + hoursWorked > WEEKLY_HOUR_THRESHOLD ? 'overtime' : 'regular';

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
