// Requires specific role(s)
const requireRole = (...roles) => {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: 'Insufficient permissions',
      });
    }
    next();
  };
};

// Requires owner role
const ownerOnly = requireRole('owner');

// Allows both owner and manager
const authenticated = requireRole('owner', 'manager');

module.exports = { requireRole, ownerOnly, authenticated };
