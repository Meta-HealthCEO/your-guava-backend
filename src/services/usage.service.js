const Organization = require('../models/Organization.model');
const UsageLedger = require('../models/UsageLedger.model');
const { getPlan, nextCreditResetDate } = require('./billingPlans.service');

const FEATURE_COSTS = {
  ask_guava_chat: { credits: 3, label: 'Ask Guava answer', provider: 'anthropic' },
  import_column_mapping: { credits: 10, label: 'AI import column mapping', provider: 'anthropic' },
  menu_item_ai_review: { credits: 1, label: 'Menu item AI review', provider: 'anthropic' },
  insight_refresh: { credits: 10, label: 'AI insight refresh', provider: 'anthropic' },
  history_backfill_day: { credits: 1, label: 'Historical forecast backfill day', provider: 'weather' },
};

const ensureFreshCreditWindow = (org) => {
  const now = new Date();
  const plan = getPlan(org.plan);
  const planIncluded = plan.includedGuavaCredits ?? plan.includedAiCredits;
  if (!org.aiCredits?.resetAt || org.aiCredits.resetAt <= now) {
    org.aiCredits = {
      included: planIncluded,
      bonus: org.aiCredits?.bonus || 0,
      used: 0,
      resetAt: nextCreditResetDate(),
    };
  } else if (org.aiCredits.included !== planIncluded) {
    org.aiCredits.included = planIncluded;
  }
};

const creditSnapshot = (org) => {
  const plan = getPlan(org.plan);
  const included = org.aiCredits?.included ?? plan.includedGuavaCredits ?? plan.includedAiCredits;
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

const insufficientCreditsError = (credits, amount) => {
  const err = new Error('Guava credit limit reached for this billing period');
  err.statusCode = 402;
  err.details = { ...credits, required: amount };
  return err;
};

const reserveGuavaCredits = async (orgId, amount = 1) => {
  const org = await Organization.findById(orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  ensureFreshCreditWindow(org);
  const credits = creditSnapshot(org);
  if (credits.available < amount) {
    throw insufficientCreditsError(credits, amount);
  }

  org.aiCredits.used = (org.aiCredits.used || 0) + amount;
  await org.save();
  return { org, credits: creditSnapshot(org) };
};

const refundGuavaCredits = async (orgId, amount = 1) => {
  const org = await Organization.findById(orgId);
  if (!org) return null;
  ensureFreshCreditWindow(org);
  org.aiCredits.used = Math.max(0, (org.aiCredits.used || 0) - amount);
  await org.save();
  return creditSnapshot(org);
};

const recordUsage = async ({
  orgId,
  cafeId,
  userId,
  featureKey,
  credits,
  status = 'committed',
  provider,
  label,
  relatedEntity,
  metadata,
}) =>
  UsageLedger.create({
    orgId,
    cafeId,
    userId,
    featureKey,
    label: label || FEATURE_COSTS[featureKey]?.label || featureKey,
    credits,
    status,
    provider: provider || FEATURE_COSTS[featureKey]?.provider || 'guava',
    relatedEntity,
    metadata,
  });

const meterGuavaCredits = async ({
  orgId,
  cafeId,
  userId,
  featureKey,
  credits,
  provider,
  label,
  relatedEntity,
  metadata,
  run,
}) => {
  const config = FEATURE_COSTS[featureKey] || {};
  const amount = Math.max(0, Number(credits ?? config.credits ?? 1) || 0);

  if (amount === 0) {
    const result = await run();
    const org = await Organization.findById(orgId);
    return { result, guavaCredits: org ? creditSnapshot(org) : null, usage: null };
  }

  let ledger = null;
  let reserved = false;
  try {
    await reserveGuavaCredits(orgId, amount);
    reserved = true;
    const result = await run();
    ledger = await recordUsage({
      orgId,
      cafeId,
      userId,
      featureKey,
      credits: amount,
      provider: provider || config.provider,
      label: label || config.label,
      relatedEntity,
      metadata,
    });
    const org = await Organization.findById(orgId);
    return { result, guavaCredits: creditSnapshot(org), usage: ledger };
  } catch (error) {
    if (reserved) await refundGuavaCredits(orgId, amount);
    if (ledger) {
      ledger.status = 'refunded';
      await ledger.save();
    }
    throw error;
  }
};

const consumeGuavaCredits = async (orgId, amount = 1, options = {}) => {
  await reserveGuavaCredits(orgId, amount);
  await recordUsage({
    orgId,
    credits: amount,
    featureKey: options.featureKey || 'manual',
    label: options.label || 'Manual credit usage',
    provider: options.provider,
    cafeId: options.cafeId,
    userId: options.userId,
    relatedEntity: options.relatedEntity,
    metadata: options.metadata,
  });
  const org = await Organization.findById(orgId);
  return creditSnapshot(org);
};

const usageSummary = async (orgId, { limit = 12 } = {}) => {
  const since = new Date();
  since.setMonth(since.getMonth() - 1);

  const [byFeature, recent] = await Promise.all([
    UsageLedger.aggregate([
      {
        $match: {
          orgId,
          status: 'committed',
          createdAt: { $gte: since },
        },
      },
      {
        $group: {
          _id: '$featureKey',
          label: { $first: '$label' },
          credits: { $sum: '$credits' },
          count: { $sum: 1 },
        },
      },
      { $sort: { credits: -1 } },
    ]),
    UsageLedger.find({ orgId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean(),
  ]);

  return {
    byFeature: byFeature.map((row) => ({
      featureKey: row._id,
      label: row.label,
      credits: row.credits,
      count: row.count,
    })),
    recent: recent.map((entry) => ({
      id: entry._id,
      featureKey: entry.featureKey,
      label: entry.label,
      credits: entry.credits,
      status: entry.status,
      provider: entry.provider,
      createdAt: entry.createdAt,
    })),
  };
};

module.exports = {
  FEATURE_COSTS,
  consumeGuavaCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
  refundGuavaCredits,
  usageSummary,
};
