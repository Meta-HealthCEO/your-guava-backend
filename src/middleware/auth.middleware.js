const jwt = require('jsonwebtoken');
const User = require('../models/User.model');
const Organization = require('../models/Organization.model');
const { billingAccessForOrganization } = require('../services/usage.service');

const BILLING_EXEMPT_PATHS = ['/api/account', '/api/auth'];

const sessionExpired = (res) =>
  res.status(401).json({ success: false, message: 'Session expired. Please sign in again' });

const isBillingExempt = (req) => {
  const path = String(req.originalUrl || '').split('?')[0];
  return BILLING_EXEMPT_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .select('tokenVersion role orgId cafeIds activeCafeId permissions')
      .lean();

    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }

    const tokenVersion = Number(decoded.tokenVersion || 0);
    const currentTokenVersion = Number(user.tokenVersion || 0);
    if (tokenVersion !== currentTokenVersion) {
      return sessionExpired(res);
    }

    const liveOrgId = user.orgId ? String(user.orgId) : null;
    const tokenOrgId = decoded.orgId ? String(decoded.orgId) : null;
    const liveCafeIds = (user.cafeIds || []).map(String);
    const tokenCafeId = decoded.cafeId ? String(decoded.cafeId) : null;

    if (
      !liveOrgId ||
      tokenOrgId !== liveOrgId ||
      decoded.role !== user.role ||
      (tokenCafeId && !liveCafeIds.includes(tokenCafeId))
    ) {
      return sessionExpired(res);
    }

    const organization = await Organization.findById(liveOrgId).lean();
    if (!organization) return sessionExpired(res);

    let billing = billingAccessForOrganization(organization);
    if (!billing.allowed && ['trialing', 'active'].includes(organization.billingStatus)) {
      await Organization.updateOne(
        { _id: organization._id, billingStatus: organization.billingStatus },
        { $set: { billingStatus: 'past_due' } }
      );
      billing = { ...billing, status: 'past_due', storedStatus: 'past_due' };
    }

    req.user = {
      ...decoded,
      id: String(user._id),
      role: user.role,
      orgId: liveOrgId,
      cafeId: tokenCafeId,
      cafeIds: liveCafeIds,
      activeCafeId: user.activeCafeId ? String(user.activeCafeId) : null,
      permissions: {
        canSpendCredits:
          user.role === 'owner' || Boolean(user.permissions?.canSpendCredits),
      },
    };
    req.billing = billing;

    if (!billing.allowed && !isBillingExempt(req)) {
      return res.status(402).json({
        success: false,
        code: 'BILLING_REQUIRED',
        message: 'An active trial or paid billing period is required',
        billing: {
          status: billing.status,
          reason: billing.reason,
          periodEnd: billing.periodEnd,
        },
      });
    }

    next();
  } catch (error) {
    if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error.name)) {
      return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
    return next(error);
  }
};

module.exports = authMiddleware;
