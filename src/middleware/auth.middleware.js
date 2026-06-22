const jwt = require('jsonwebtoken');
const User = require('../models/User.model');

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('tokenVersion').lean();

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const tokenVersion = Number(decoded.tokenVersion || 0);
    const currentTokenVersion = Number(user.tokenVersion || 0);
    if (tokenVersion !== currentTokenVersion) {
      return res.status(401).json({ success: false, message: 'Session expired. Please sign in again' });
    }

    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;
