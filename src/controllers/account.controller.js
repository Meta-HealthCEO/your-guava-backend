const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const Organization = require('../models/Organization.model');
const {
  getPlan,
  getPlans,
  normalisePlanId,
  nextCreditResetDate,
} = require('../services/billingPlans.service');
const {
  createHostedPaymentSession,
  getCreditPack,
  invalidateFutureForecastsForOrg,
  reconcileOneGatePayment,
} = require('../services/billingPayments.service');
const {
  creditSnapshot,
  ensureFreshCreditWindow,
  usageSummary,
} = require('../services/usage.service');
const oneGate = require('../services/onegate.service');
const { clearApiCache } = require('../middleware/cache.middleware');

const mockBillingEnabled = () => process.env.NODE_ENV !== 'production';

const billingNotConfigured = (res) =>
  res.status(503).json({
    success: false,
    code: 'BILLING_PROVIDER_NOT_CONFIGURED',
    message: 'Card payments are not configured. Enable OneGate before accepting paid plan or credit purchases.',
  });

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
  const usageLedger = await usageSummary(org._id);

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
      guavaCredits: credits,
      creditLedger: usageLedger,
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

const getCreditBalance = async (req, res, next) => {
  try {
    let orgId = req.user.orgId;

    if (!orgId) {
      const user = await User.findById(req.user.id).select('orgId').lean();
      orgId = user?.orgId;
    }

    const org = await Organization.findById(orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    ensureFreshCreditWindow(org);
    await org.save();

    const plan = getPlan(org.plan);
    return res.status(200).json({
      success: true,
      credits: creditSnapshot(org),
      organization: {
        plan: normalisePlanId(org.plan),
        billingStatus: org.billingStatus,
        billingCycle: org.billingCycle,
      },
      plan: {
        id: plan.id,
        name: plan.name,
        includedGuavaCredits: plan.includedGuavaCredits ?? plan.includedAiCredits,
      },
    });
  } catch (error) {
    next(error);
  }
};

const updateProfile = async (req, res, next) => {
  try {
    const { name, organizationName, billingEmail } = req.body;

    const user = await User.findById(req.user.id);
    const org = await Organization.findById(user.orgId);

    // Organization-level fields are owner-only; anyone can update their own name.
    if ((organizationName || billingEmail) && user.role !== 'owner') {
      return res
        .status(403)
        .json({ success: false, message: 'Only the owner can change organization details' });
    }

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
    clearApiCache();

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({ success: true, account });
  } catch (error) {
    next(error);
  }
};

const mockCheckout = async ({ req, org, selectedPlan, billingCycle, paymentMethod }) => {
  const planChanged = org.plan !== selectedPlan.id;
  org.plan = selectedPlan.id;
  org.billingCycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  org.billingStatus = 'active';
  org.mockCustomerId = org.mockCustomerId || `mock_cus_${org._id.toString().slice(-8)}`;
  org.paymentMethod = {
    brand: paymentMethod?.brand || 'visa',
    last4: paymentMethod?.last4 || '4242',
    expiresAt: paymentMethod?.expiresAt || '12/30',
    provider: 'mock',
  };
  org.aiCredits = {
    included: selectedPlan.includedGuavaCredits ?? selectedPlan.includedAiCredits,
    bonus: org.aiCredits?.bonus || 0,
    used: 0,
    resetAt: nextCreditResetDate(),
  };
  await org.save();

  if (planChanged) {
    await invalidateFutureForecastsForOrg(org._id);
  }
  clearApiCache();

  const account = await buildAccountPayload(req.user.id);
  return {
    checkout: {
      provider: 'mock',
      receiptId: `mock_rcpt_${Date.now()}`,
      amount: org.billingCycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly,
      currency: 'ZAR',
      status: 'paid',
    },
    account,
  };
};

const checkout = async (req, res, next) => {
  try {
    const { plan, billingCycle = 'monthly', paymentMethod } = req.body;
    const selectedPlan = getPlan(plan);

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    if (oneGate.isOneGateEnabled()) {
      const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
      const amount = cycle === 'annual' ? selectedPlan.priceAnnual : selectedPlan.priceMonthly;
      const session = await createHostedPaymentSession({
        org,
        userId: req.user.id,
        kind: 'plan',
        plan: selectedPlan.id,
        billingCycle: cycle,
        amount,
      });

      const account = await buildAccountPayload(req.user.id);
      return res.status(200).json({
        success: true,
        checkout: {
          provider: 'onegate',
          reference: session.reference,
          paymentKey: session.providerPaymentKey,
          redirectUrl: session.checkoutUrl,
          amount: session.amount,
          currency: session.currency,
          status: session.status,
        },
        account,
      });
    }

    if (!mockBillingEnabled()) return billingNotConfigured(res);

    const { checkout: mock, account } = await mockCheckout({
      req,
      org,
      selectedPlan,
      billingCycle,
      paymentMethod,
    });

    return res.status(200).json({
      success: true,
      checkout: mock,
      account,
    });
  } catch (error) {
    next(error);
  }
};

const buyAiCredits = async (req, res, next) => {
  try {
    const { credits = 250 } = req.body;

    const org = await Organization.findById(req.user.orgId);
    if (!org) {
      return res.status(404).json({ success: false, message: 'Organization not found' });
    }

    const pack = getCreditPack(org, credits);

    if (oneGate.isOneGateEnabled()) {
      const session = await createHostedPaymentSession({
        org,
        userId: req.user.id,
        kind: 'credits',
        credits: pack.credits,
        amount: pack.price,
      });

      const account = await buildAccountPayload(req.user.id);
      return res.status(200).json({
        success: true,
        purchase: {
          provider: 'onegate',
          reference: session.reference,
          paymentKey: session.providerPaymentKey,
          redirectUrl: session.checkoutUrl,
          credits: pack.credits,
          amount: session.amount,
          currency: session.currency,
          status: session.status,
        },
        account,
      });
    }

    if (!mockBillingEnabled()) return billingNotConfigured(res);

    ensureFreshCreditWindow(org);
    org.aiCredits.bonus = (org.aiCredits?.bonus || 0) + pack.credits;
    await org.save();
    clearApiCache();

    const account = await buildAccountPayload(req.user.id);
    return res.status(200).json({
      success: true,
      purchase: {
        provider: 'mock',
        receiptId: `mock_guava_${Date.now()}`,
        credits: pack.credits,
        amount: pack.price,
        currency: 'ZAR',
        status: 'paid',
      },
      account,
    });
  } catch (error) {
    next(error);
  }
};

const oneGateReferenceFromRequest = (req) =>
  req.body?.merchant_reference || req.body?.reference || req.query?.reference;

const handleOneGateWebhook = async (req, res, next) => {
  try {
    const reference = oneGateReferenceFromRequest(req);
    if (!reference) {
      return res.status(400).json({ success: false, message: 'Missing payment reference' });
    }

    await reconcileOneGatePayment(reference, req.body);
    clearApiCache();
    return res.status(200).json({ success: true });
  } catch (error) {
    if (error.statusCode === 202) {
      return res.status(202).json({ success: false, message: error.message });
    }
    next(error);
  }
};

const handleOneGateReturn = async (req, res) => {
  const reference = req.query.reference;
  const requestedResult = req.query.result;
  let status = requestedResult === 'cancel' ? 'cancelled' : 'pending';

  if (reference) {
    try {
      const session = await reconcileOneGatePayment(reference);
      status = session.status === 'paid' ? 'paid' : session.status;
      clearApiCache();
    } catch (_error) {
      status = requestedResult === 'error' ? 'failed' : status;
    }
  }

  return res.redirect(oneGate.hostedCheckoutReturnUrl(status, reference));
};

const getPaymentStatus = async (req, res, next) => {
  try {
    const { reference } = req.params;
    const session = await reconcileOneGatePayment(reference).catch(async () => null);
    if (!session || String(session.orgId) !== String(req.user.orgId)) {
      return res.status(404).json({ success: false, message: 'Payment session not found' });
    }
    clearApiCache();

    return res.status(200).json({
      success: true,
      payment: {
        reference: session.reference,
        provider: session.provider,
        kind: session.kind,
        status: session.status,
        amount: session.amount,
        currency: session.currency,
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  buyAiCredits,
  checkout,
  getAccount,
  getCreditBalance,
  getPaymentStatus,
  handleOneGateReturn,
  handleOneGateWebhook,
  mockCheckout: checkout,
  updateProfile,
};
