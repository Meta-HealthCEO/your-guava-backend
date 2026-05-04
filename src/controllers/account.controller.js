const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const {
  getPlan,
  getPlans,
  normalisePlanId,
  nextCreditResetDate,
} = require('../services/billingPlans.service');
const { creditSnapshot, ensureFreshCreditWindow } = require('../services/aiUsage.service');

const buildAccountPayload = async (userId) => {
  const user = await User.findById(userId).select('-password -refreshTokens').lean();
  if (!user) {
    const err = new Error('User not found');
    err.statusCode = 404;
    throw err;
  }

  const org = await Organization.findById(user.orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  ensureFreshCreditWindow(org);
  await org.save();

  const [seatCount, locationCount] = await Promise.all([
    User.countDocuments({ orgId: org._id }),
    Cafe.countDocuments({ orgId: org._id }),
  ]);

  const plan = getPlan(org.plan);
  const credits = creditSnapshot(org);

  return {
    user: {
      id: user._id,
      email: user.email,
      name: user.name,
      role: user.role,
      orgId: user.orgId,
      cafeIds: user.cafeIds,
      activeCafeId: user.activeCafeId,
    },
    organization: {
      _id: org._id,
      name: org.name,
      ownerId: org.ownerId,
      plan: normalisePlanId(org.plan),
      billingStatus: org.billingStatus,
      billingCycle: org.billingCycle,
      billingEmail: org.billingEmail,
      paymentMethod: org.paymentMethod,
      subscriptionStartedAt: org.subscriptionStartedAt,
      createdAt: org.createdAt,
    },
    usage: {
      seats: {
        used: seatCount,
        included: plan.includedSeats,
        remaining: Math.max(0, plan.includedSeats - seatCount),
      },
      locations: {
        used: locationCount,
        included: plan.includedLocations,
        remaining: Math.max(0, plan.includedLocations - locationCount),
      },
      aiCredits: credits,
    },
    plans: getPlans(),
  };
};

const getAccount = async (req, res, next) => {
  try {
    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({ success: true, account });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const { name, organizationName, billingEmail } = req.body;

    const user = await User.findById(req.user.id);
    const org = await Organization.findById(user.orgId);

    if (name && name.trim().length >= 2) {
      user.name = name.trim();
    }
    if (organizationName && organizationName.trim().length >= 2) {
      org.name = organizationName.trim();
    }
    if (billingEmail) {
      org.billingEmail = billingEmail.trim().toLowerCase();
    }

    await Promise.all([user.save(), org.save()]);

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({ success: true, account });
  } catch (error) {
    next(error);
  }
};

const mockCheckout = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly', paymentMethod } = req.body;
    const selectedPlan = getPlan(plan);

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    org.plan = selectedPlan.id;
    org.billingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    org.billingStatus = 'active';
    org.mockCustomerId = org.mockCustomerId || `mock_cus_${org._id.toString().slice(-8)}`;
    org.paymentMethod = {
      brand: paymentMethod?.brand || 'visa',
      last4: paymentMethod?.last4 || '4242',
      expiresAt: paymentMethod?.expiresAt || '12/30',
    };
    org.aiCredits = {
      included: selectedPlan.includedAiCredits,
      bonus: org.aiCredits?.bonus || 0,
      used: 0,
      resetAt: nextCreditResetDate(),
    };
    await org.save();

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({
      success: true,
      checkout: {
        provider: 'mock',
        receiptId: `mock_rcpt_${Date.now()}`,
        amount: org.billingCycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly,
        currency: 'ZAR',
      },
      account,
    });
  } catch (error) {
    next(error);
  }
};

const buyAiCredits = async (req, res, next) => {
  try {
    const { credits = 250 } = req.body;
    const amount = Math.max(50, Math.min(Number(credits) || 250, 10000));

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    ensureFreshCreditWindow(org);
    org.aiCredits.bonus = (org.aiCredits?.bonus || 0) + amount;
    await org.save();

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({
      success: true,
      purchase: {
        provider: 'mock',
        receiptId: `mock_ai_${Date.now()}`,
        credits: amount,
        currency: 'ZAR',
      },
      account,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAccount, updateProfile, mockCheckout, buyAiCredits };
