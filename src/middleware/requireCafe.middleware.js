/**
 * Routes that read one cafe's data need a cafe in the session (analytics-ai-23). A user with no cafes holds a valid token with
 * cafeId null; without this guard ObjectId.createFromHexString(null) threw a 500 and new ObjectId(null) silently matched nothing.
 */
const requireActiveCafe = (req, res, next) => {
  if (!req.user?.cafeId) {
    return res.status(400).json({ success: false, code: 'CAFE_REQUIRED', message: 'Select a cafe location first.' });
  }
  return next();
};

module.exports = { requireActiveCafe };
