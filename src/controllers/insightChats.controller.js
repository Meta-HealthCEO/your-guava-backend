const InsightChat = require('../models/InsightChat.model');

const MAX_MESSAGES = 80;

const buildTitle = (title, messages = []) => {
  if (typeof title === 'string' && title.trim()) {
    return title.trim().slice(0, 80);
  }

  const firstUserMessage = messages.find((message) => message.role === 'user')?.content || '';
  const normalized = firstUserMessage.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 60) : 'New chat';
};

const sanitizeMessages = (messages = []) =>
  messages
    .filter((message) =>
      message &&
      ['user', 'assistant'].includes(message.role) &&
      typeof message.content === 'string' &&
      message.content.trim()
    )
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 20000),
    }));

const chatScope = (req, extra = {}) => ({
  ...extra,
  userId: req.user.id,
  cafeId: req.user.cafeId,
});

const list = async (req, res, next) => {
  try {
    const includeArchived = req.query.archived === 'true';
    const filter = chatScope(req, includeArchived ? {} : { archived: false });

    const chats = await InsightChat.find(filter)
      .sort({ updatedAt: -1 })
      .limit(60)
      .select('title messages contextStats archived updatedAt createdAt')
      .lean();

    return res.status(200).json({ success: true, chats });
  } catch (error) {
    next(error);
  }
};

const create = async (req, res, next) => {
  try {
    const messages = sanitizeMessages(req.body.messages);
    const chat = await InsightChat.create({
      userId: req.user.id,
      cafeId: req.user.cafeId,
      orgId: req.user.orgId,
      title: buildTitle(req.body.title, messages),
      messages,
      contextStats: req.body.contextStats || {},
      archived: Boolean(req.body.archived),
    });

    return res.status(201).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const getOne = async (req, res, next) => {
  try {
    const chat = await InsightChat.findOne(chatScope(req, { _id: req.params.id })).lean();

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const update = async (req, res, next) => {
  try {
    const updates = {};

    if (typeof req.body.title === 'string') updates.title = buildTitle(req.body.title);
    if (Array.isArray(req.body.messages)) updates.messages = sanitizeMessages(req.body.messages);
    if (req.body.contextStats && typeof req.body.contextStats === 'object') {
      updates.contextStats = req.body.contextStats;
    }
    if (typeof req.body.archived === 'boolean') updates.archived = req.body.archived;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, message: 'No valid updates provided' });
    }

    const chat = await InsightChat.findOneAndUpdate(
      chatScope(req, { _id: req.params.id }),
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, chat });
  } catch (error) {
    next(error);
  }
};

const remove = async (req, res, next) => {
  try {
    const chat = await InsightChat.findOneAndDelete(chatScope(req, { _id: req.params.id }));

    if (!chat) {
      return res.status(404).json({ success: false, message: 'Chat not found' });
    }

    return res.status(200).json({ success: true, message: 'Chat deleted' });
  } catch (error) {
    next(error);
  }
};

module.exports = { list, create, getOne, update, remove };
