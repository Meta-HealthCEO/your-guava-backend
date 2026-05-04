const Organization = require('../models/Organization.model');
const { getPlan, nextCreditResetDate } = require('./billingPlans.service');

const ensureFreshCreditWindow = (org) => {
  const now = new Date();
  if (!org.aiCredits?.resetAt || org.aiCredits.resetAt <= now) {
    const plan = getPlan(org.plan);
    org.aiCredits = {
      included: plan.includedAiCredits,
      bonus: org.aiCredits?.bonus || 0,
      used: 0,
      resetAt: nextCreditResetDate(),
    };
  }
};

const creditSnapshot = (org) => {
  const included = org.aiCredits?.included ?? getPlan(org.plan).includedAiCredits;
  const bonus = org.aiCredits?.bonus || 0;
  const used = org.aiCredits?.used || 0;
  return {
    included,
    bonus,
    used,
    available: Math.max(0, included + bonus - used),
    resetAt: org.aiCredits?.resetAt || null,
  };
};

const consumeAiCredits = async (orgId, amount = 1) => {
  const org = await Organization.findById(orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  ensureFreshCreditWindow(org);
  const credits = creditSnapshot(org);

  if (credits.available < amount) {
    const err = new Error('AI credit limit reached for this billing period');
    err.statusCode = 402;
    err.details = credits;
    throw err;
  }

  org.aiCredits.used = (org.aiCredits.used || 0) + amount;
  await org.save();

  return creditSnapshot(org);
};

module.exports = { consumeAiCredits, creditSnapshot, ensureFreshCreditWindow };
