const mongoose = require('mongoose');
const Improvement = require('../models/Improvement.model');
const User = require('../models/User.model');

const { IMPROVEMENT_TYPES, IMPROVEMENT_AREAS, PRIORITIES, STATUSES } = Improvement;

const isValidId = (id) => mongoose.isValidObjectId(id);
const enumMessage = (name, allowed) => `${name} must be one of: ${allowed.join(', ')}`;

const getOrgId = (req, res) => {
  if (!req.user?.orgId || !isValidId(req.user.orgId)) {
    res.status(403).json({ success: false, message: 'Organization context is required' });
    return null;
  }
  return req.user.orgId;
};

const parseEnum = (name, value, allowed) => {
  if (value == null || value === '') return { value: undefined };
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return { error: enumMessage(name, allowed) };
  }
  return { value };
};

const improvementAccessFilter = (req, orgId, { aggregate = false } = {}) => {
  const normalizedOrgId = aggregate
    ? new mongoose.Types.ObjectId(String(orgId))
    : orgId;
  if (req.user.role === 'owner') return { orgId: normalizedOrgId };

  const cafeIds = (req.user.cafeIds || [])
    .filter((id) => isValidId(id))
    .map((id) => (aggregate ? new mongoose.Types.ObjectId(String(id)) : id));
  return {
    orgId: normalizedOrgId,
    cafeId: { $in: cafeIds },
  };
};

// POST /api/improvements — Log a new improvement or fix.
const create = async (req, res, next) => {
  try {
    const orgId = getOrgId(req, res);
    if (!orgId) return;

    const { type, title, area, priority, description, desiredOutcome, pageUrl } = req.body;

    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ success: false, message: 'Title is required' });
    }
    if (typeof description !== 'string' || !description.trim()) {
      return res.status(400).json({ success: false, message: 'Description is required' });
    }
    if (title.trim().length > 140) {
      return res.status(400).json({ success: false, message: 'Title must be 140 characters or fewer' });
    }
    if (description.trim().length > 4000) {
      return res
        .status(400)
        .json({ success: false, message: 'Description must be 4000 characters or fewer' });
    }
    if (desiredOutcome != null && typeof desiredOutcome !== 'string') {
      return res.status(400).json({ success: false, message: 'desiredOutcome must be text' });
    }
    if (typeof desiredOutcome === 'string' && desiredOutcome.trim().length > 2000) {
      return res
        .status(400)
        .json({ success: false, message: 'Desired outcome must be 2000 characters or fewer' });
    }
    if (pageUrl != null && typeof pageUrl !== 'string') {
      return res.status(400).json({ success: false, message: 'pageUrl must be text' });
    }
    if (typeof pageUrl === 'string' && pageUrl.trim().length > 300) {
      return res.status(400).json({ success: false, message: 'Page URL must be 300 characters or fewer' });
    }
    if (type && !IMPROVEMENT_TYPES.includes(type)) {
      return res
        .status(400)
        .json({ success: false, message: enumMessage('type', IMPROVEMENT_TYPES) });
    }
    if (area && !IMPROVEMENT_AREAS.includes(area)) {
      return res
        .status(400)
        .json({ success: false, message: enumMessage('area', IMPROVEMENT_AREAS) });
    }
    if (priority && !PRIORITIES.includes(priority)) {
      return res
        .status(400)
        .json({ success: false, message: enumMessage('priority', PRIORITIES) });
    }

    // Denormalize the reporter so a ticket is self-explanatory when read in the DB.
    const reporter = await User.findById(req.user.id).select('name email').lean();

    const improvement = await Improvement.create({
      type: type || 'improvement',
      title: String(title).trim(),
      area: area || 'other',
      priority: priority || 'medium',
      description: String(description).trim(),
      desiredOutcome: desiredOutcome ? String(desiredOutcome).trim() : undefined,
      pageUrl: pageUrl ? String(pageUrl).trim().slice(0, 300) : undefined,
      status: 'open',
      orgId,
      cafeId: req.user.cafeId || undefined,
      createdBy: {
        userId: req.user.id,
        name: reporter?.name,
        email: reporter?.email,
      },
    });

    return res.status(201).json({ success: true, improvement });
  } catch (error) {
    next(error);
  }
};

// GET /api/improvements — List the organisation's improvements with filters + counts.
const list = async (req, res, next) => {
  try {
    const orgId = getOrgId(req, res);
    if (!orgId) return;

    const { status, type, area, priority } = req.query;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, Number.parseInt(req.query.limit, 10) || 50));

    const filter = improvementAccessFilter(req, orgId);
    for (const [name, value, allowed] of [
      ['status', status, STATUSES],
      ['type', type, IMPROVEMENT_TYPES],
      ['area', area, IMPROVEMENT_AREAS],
      ['priority', priority, PRIORITIES],
    ]) {
      const parsed = parseEnum(name, value, allowed);
      if (parsed.error) {
        return res.status(400).json({ success: false, message: parsed.error });
      }
      if (parsed.value) filter[name] = parsed.value;
    }

    const [total, improvements, statusGroups] = await Promise.all([
      Improvement.countDocuments(filter),
      Improvement.find(filter)
        .sort({ ticketNumber: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Improvement.aggregate([
        { $match: improvementAccessFilter(req, orgId, { aggregate: true }) },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
    ]);

    // Counts per status (plus a total) for the UI filter tabs.
    const counts = STATUSES.reduce((acc, value) => ({ ...acc, [value]: 0 }), {});
    let allCount = 0;
    for (const group of statusGroups) {
      if (group._id in counts) counts[group._id] = group.count;
      allCount += group.count;
    }
    counts.all = allCount;

    return res.status(200).json({
      success: true,
      improvements,
      counts,
      pagination: {
        total,
        page,
        limit,
        pages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/improvements/:id — Fetch a single improvement (org-scoped).
const getOne = async (req, res, next) => {
  try {
    const orgId = getOrgId(req, res);
    if (!orgId) return;

    if (!isValidId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    const improvement = await Improvement.findOne({
      _id: req.params.id,
      ...improvementAccessFilter(req, orgId),
    }).lean();
    if (!improvement) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    return res.status(200).json({ success: true, improvement });
  } catch (error) {
    next(error);
  }
};

// PATCH /api/improvements/:id/status — Move a ticket through the workflow (owner only).
const updateStatus = async (req, res, next) => {
  try {
    const orgId = getOrgId(req, res);
    if (!orgId) return;

    if (!isValidId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    const { status, resolutionNotes } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: 'status is required' });
    }
    if (!STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: enumMessage('status', STATUSES) });
    }
    if (resolutionNotes !== undefined && typeof resolutionNotes !== 'string') {
      return res.status(400).json({ success: false, message: 'resolutionNotes must be text' });
    }
    if (typeof resolutionNotes === 'string' && resolutionNotes.trim().length > 2000) {
      return res
        .status(400)
        .json({ success: false, message: 'Resolution notes must be 2000 characters or fewer' });
    }

    const update = { status };
    if (resolutionNotes !== undefined) {
      update.resolutionNotes = resolutionNotes.trim();
    }

    const improvement = await Improvement.findOneAndUpdate(
      { _id: req.params.id, orgId },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!improvement) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    return res.status(200).json({ success: true, improvement });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/improvements/:id — Remove a ticket (owner only).
const remove = async (req, res, next) => {
  try {
    const orgId = getOrgId(req, res);
    if (!orgId) return;

    if (!isValidId(req.params.id)) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    const improvement = await Improvement.findOneAndDelete({
      _id: req.params.id,
      orgId,
    });
    if (!improvement) {
      return res.status(404).json({ success: false, message: 'Improvement not found' });
    }
    return res.status(200).json({ success: true, message: 'Improvement deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { create, list, getOne, updateStatus, remove };
