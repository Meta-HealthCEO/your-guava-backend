const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../models/Organization.model');
const UsageLedger = require('../models/UsageLedger.model');
const {
  addBillingCycle,
  addUtcMonthsClamped,
  getPlan,
  nextMonthlyAnniversary,
} = require('./billingPlans.service');

const FEATURE_COSTS = {
  ask_guava_chat: { credits: 3, label: 'Ask Guava answer', provider: 'anthropic' },
  import_column_mapping: { credits: 10, label: 'AI import column mapping', provider: 'anthropic' },
  menu_item_ai_review: { credits: 1, label: 'Menu item AI review', provider: 'anthropic' },
  insight_refresh: { credits: 10, label: 'AI insight refresh', provider: 'anthropic' },
  history_backfill_day: { credits: 1, label: 'Historical forecast backfill day', provider: 'weather' },
};

const DEFAULT_TRIAL_DAYS = 14;
const DEFAULT_TRIAL_MS = DEFAULT_TRIAL_DAYS * 24 * 60 * 60 * 1000;
const DEFAULT_USAGE_RESERVATION_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE = 50;
const USAGE_DIAGNOSTICS_FIELD = '__usageDiagnostics';
const AI_FEATURE_KEYS = new Set([
  'ask_guava_chat',
  'import_column_mapping',
  'menu_item_ai_review',
  'insight_refresh',
]);

const boundedPolicyInteger = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, parsed))
    : fallback;
};

const aiUsagePolicy = () => ({
  userDailyCredits: boundedPolicyInteger(
    process.env.AI_USER_DAILY_CREDIT_LIMIT,
    500,
    10,
    100_000
  ),
  orgDailyCredits: boundedPolicyInteger(
    process.env.AI_ORG_DAILY_CREDIT_LIMIT,
    2_000,
    10,
    1_000_000
  ),
  userConcurrency: boundedPolicyInteger(
    process.env.AI_USER_CONCURRENCY_LIMIT,
    2,
    1,
    20
  ),
  orgConcurrency: boundedPolicyInteger(
    process.env.AI_ORG_CONCURRENCY_LIMIT,
    8,
    1,
    100
  ),
});

const asDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const inferredTrialEnd = (org) => {
  const explicit = asDate(org?.trialEndsAt);
  if (explicit) return explicit;
  const createdAt = asDate(org?.createdAt || org?.trialStartedAt);
  return createdAt ? new Date(createdAt.getTime() + DEFAULT_TRIAL_MS) : null;
};

const inferredCurrentPeriodEnd = (org) => {
  const explicit = asDate(org?.currentPeriodEnd);
  if (explicit) return explicit;
  const startedAt = asDate(org?.subscriptionStartedAt || org?.currentPeriodStart);
  return startedAt ? addBillingCycle(startedAt, org?.billingCycle) : null;
};

const billingAccessForOrganization = (org, now = new Date()) => {
  if (!org) {
    return { allowed: false, status: 'missing', reason: 'organization_missing', periodEnd: null };
  }

  const current = asDate(now) || new Date();
  const status = org.billingStatus || 'past_due';
  if (status === 'trialing') {
    const periodEnd = inferredTrialEnd(org);
    const allowed = Boolean(periodEnd && periodEnd > current);
    return {
      allowed,
      status: allowed ? status : 'past_due',
      storedStatus: status,
      reason: allowed ? null : 'trial_expired',
      periodEnd,
      trialEndsAt: periodEnd,
    };
  }

  if (status === 'active') {
    const periodEnd = inferredCurrentPeriodEnd(org);
    const allowed = Boolean(periodEnd && periodEnd > current);
    return {
      allowed,
      status: allowed ? status : 'past_due',
      storedStatus: status,
      reason: allowed ? null : 'billing_period_expired',
      periodEnd,
      currentPeriodEnd: periodEnd,
    };
  }

  return {
    allowed: false,
    status,
    storedStatus: status,
    reason: status === 'canceled' ? 'subscription_canceled' : 'payment_required',
    periodEnd: inferredCurrentPeriodEnd(org) || inferredTrialEnd(org),
  };
};

const billingRequiredError = (access) => {
  const err = new Error('An active trial or paid billing period is required');
  err.statusCode = 402;
  err.code = 'BILLING_REQUIRED';
  err.details = {
    code: err.code,
    billingStatus: access?.status || 'past_due',
    reason: access?.reason || 'payment_required',
    periodEnd: access?.periodEnd || null,
  };
  return err;
};

/**
 * The instant the paid credit window is anchored on: the start of the billing
 * period, which is the only value that says when this organisation's month
 * begins.
 */
const creditWindowAnchor = (org, access, now) => {
  const explicitStart = asDate(org?.currentPeriodStart) || asDate(org?.subscriptionStartedAt);
  if (explicitStart) return explicitStart;

  // A legacy document may carry only a period end. Stepping it back by the
  // billing cycle recovers the start, so an annual subscriber keeps refreshing
  // monthly instead of waiting a year for the end date itself to come round.
  const periodEnd = asDate(access?.periodEnd);
  if (periodEnd) {
    return addUtcMonthsClamped(periodEnd, org?.billingCycle === 'annual' ? -12 : -1);
  }
  return asDate(org?.aiCredits?.resetAt) || now;
};

const creditResetDateForOrganization = (
  org,
  access = billingAccessForOrganization(org),
  now = new Date()
) => {
  // A trial is a single window: one allowance for the whole trial.
  if (access.status === 'trialing' && access.periodEnd) return new Date(access.periodEnd);

  // A paid allowance renews on the subscription's own monthly anniversary.
  // Taking the earlier of the calendar rollover and the period end used to hand
  // every organisation whose renewal day was not the 1st two full allowances a
  // month -- one at the rollover and a second at its own renewal -- so the
  // period end now caps access only and never grants credits.
  return nextMonthlyAnniversary(creditWindowAnchor(org, access, now), now);
};

const nonNegativeNumber = (value) => Math.max(0, Number(value) || 0);

const hasStoredBonusUsed = (org) => {
  if (org?.aiCredits?.bonusUsed == null) return false;
  return !(typeof org.$isDefault === 'function' && org.$isDefault('aiCredits.bonusUsed'));
};

// Legacy organizations only stored one combined `used` counter. Included credits
// have always been consumed first, so any usage above the included allowance is
// the only purchased-credit usage that can be inferred safely during migration.
const bonusUsedForCredits = (org) => {
  const plan = getPlan(org?.plan);
  const included = nonNegativeNumber(
    org?.aiCredits?.included ?? plan.includedGuavaCredits ?? plan.includedAiCredits
  );
  const bonus = nonNegativeNumber(org?.aiCredits?.bonus);
  const used = nonNegativeNumber(org?.aiCredits?.used);
  const stored = hasStoredBonusUsed(org)
    ? nonNegativeNumber(org.aiCredits.bonusUsed)
    : Math.max(0, used - included);
  return Math.min(bonus, stored);
};

const creditComponents = (org) => {
  const plan = getPlan(org?.plan);
  const included = nonNegativeNumber(
    org?.aiCredits?.included ?? plan.includedGuavaCredits ?? plan.includedAiCredits
  );
  const bonus = nonNegativeNumber(org?.aiCredits?.bonus);
  const bonusUsed = bonusUsedForCredits(org);
  const used = Math.max(nonNegativeNumber(org?.aiCredits?.used), bonusUsed);
  const includedUsed = Math.min(included, Math.max(0, used - bonusUsed));
  return {
    included,
    bonus,
    used,
    bonusUsed,
    includedUsed,
    includedAvailable: Math.max(0, included - includedUsed),
    bonusAvailable: Math.max(0, bonus - bonusUsed),
  };
};

const ensureFreshCreditWindow = (org, now = new Date()) => {
  if (!org) return org;
  const access = billingAccessForOrganization(org, now);
  if (!access.allowed) return org;

  const plan = getPlan(org.plan);
  const planIncluded = plan.includedGuavaCredits ?? plan.includedAiCredits;
  const resetAt = asDate(org.aiCredits?.resetAt);
  const bonusUsed = bonusUsedForCredits(org);
  if (!resetAt || resetAt <= now) {
    org.aiCredits = {
      included: planIncluded,
      bonus: org.aiCredits?.bonus || 0,
      bonusUsed,
      used: bonusUsed,
      resetAt: creditResetDateForOrganization(org, access, now),
    };
  } else {
    if (org.aiCredits.included !== planIncluded) org.aiCredits.included = planIncluded;
    org.aiCredits.bonusUsed = bonusUsed;
    if (nonNegativeNumber(org.aiCredits.used) < bonusUsed) org.aiCredits.used = bonusUsed;
  }
  return org;
};

const creditSnapshot = (org, now = new Date()) => {
  const { included, bonus, used, bonusUsed } = creditComponents(org);
  const access = billingAccessForOrganization(org, now);
  return {
    included,
    bonus,
    bonusUsed,
    used,
    available: access.allowed ? Math.max(0, included + bonus - used) : 0,
    resetAt: org.aiCredits?.resetAt || null,
  };
};

const refreshCreditWindow = async (orgId, now = new Date(), attempts = 0) => {
  const org = await Organization.findById(orgId);
  if (!org) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }

  const access = billingAccessForOrganization(org, now);
  if (!access.allowed) return org;

  const plan = getPlan(org.plan);
  const planIncluded = plan.includedGuavaCredits ?? plan.includedAiCredits;
  const resetAt = asDate(org.aiCredits?.resetAt);
  const stale = !resetAt || resetAt <= now;
  const bonusUsed = bonusUsedForCredits(org);
  const set = {};

  if (!org.trialEndsAt && access.trialEndsAt) set.trialEndsAt = access.trialEndsAt;
  if (!org.currentPeriodEnd && access.currentPeriodEnd) set.currentPeriodEnd = access.currentPeriodEnd;
  if (stale) {
    set['aiCredits.included'] = planIncluded;
    set['aiCredits.bonusUsed'] = bonusUsed;
    set['aiCredits.used'] = bonusUsed;
    set['aiCredits.resetAt'] = creditResetDateForOrganization(org, access, now);
  } else {
    if (org.aiCredits?.included !== planIncluded) set['aiCredits.included'] = planIncluded;
    if (!hasStoredBonusUsed(org) || org.aiCredits.bonusUsed !== bonusUsed) {
      set['aiCredits.bonusUsed'] = bonusUsed;
    }
    if (nonNegativeNumber(org.aiCredits?.used) < bonusUsed) set['aiCredits.used'] = bonusUsed;
  }

  if (Object.keys(set).length === 0) return org;
  const updated = await Organization.findOneAndUpdate(
    { _id: org._id, __v: org.__v },
    { $set: set, $inc: { __v: 1 } },
    { new: true, runValidators: true }
  );
  if (updated) return updated;
  if (attempts >= 2) return Organization.findById(orgId);
  return refreshCreditWindow(orgId, now, attempts + 1);
};

const normalizeCreditAmount = (amount) => Math.max(0, Math.ceil(Number(amount) || 0));

const insufficientCreditsError = (credits, amount) => {
  const err = new Error('Guava credit limit reached for this billing period');
  err.statusCode = 402;
  err.details = { ...credits, required: amount };
  return err;
};

const mongoIncludedCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.included', 0] }] });
const mongoBonusCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.bonus', 0] }] });
const mongoRawUsedCredits = () => ({ $max: [0, { $ifNull: ['$aiCredits.used', 0] }] });
const mongoBonusUsedCredits = () => ({
  $min: [
    mongoBonusCredits(),
    {
      $max: [
        0,
        {
          $ifNull: [
            '$aiCredits.bonusUsed',
            { $subtract: [mongoRawUsedCredits(), mongoIncludedCredits()] },
          ],
        },
      ],
    },
  ],
});
const mongoEffectiveUsedCredits = () => ({
  $max: [mongoRawUsedCredits(), mongoBonusUsedCredits()],
});
const mongoIncludedAvailableCredits = () => ({
  $max: [
    0,
    {
      $subtract: [
        mongoIncludedCredits(),
        {
          $max: [
            0,
            { $subtract: [mongoEffectiveUsedCredits(), mongoBonusUsedCredits()] },
          ],
        },
      ],
    },
  ],
});

const reserveCreditsAtomic = async (orgId, requested, now, session) => {
  const before = await Organization.findOneAndUpdate(
    {
      _id: orgId,
      $or: [
        { billingStatus: 'trialing', trialEndsAt: { $gt: now } },
        { billingStatus: 'active', currentPeriodEnd: { $gt: now } },
      ],
      $expr: {
        $gte: [
          {
            $subtract: [
              {
                $add: [
                  mongoIncludedCredits(),
                  mongoBonusCredits(),
                ],
              },
              mongoEffectiveUsedCredits(),
            ],
          },
          requested,
        ],
      },
    },
    [
      {
        $set: {
          'aiCredits.used': { $add: [mongoEffectiveUsedCredits(), requested] },
          'aiCredits.bonusUsed': {
            $add: [
              mongoBonusUsedCredits(),
              {
                $subtract: [
                  requested,
                  { $min: [requested, mongoIncludedAvailableCredits()] },
                ],
              },
            ],
          },
          __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
        },
      },
    ],
    { new: false, ...(session ? { session } : {}) }
  );

  if (!before) return null;
  const state = creditComponents(before);
  const included = Math.min(requested, state.includedAvailable);
  const allocation = { included, bonus: requested - included };
  let currentQuery = Organization.findById(orgId);
  if (session) currentQuery = currentQuery.session(session);
  const org = await currentQuery;
  return { org, allocation };
};

const throwCreditReservationError = async (orgId, requested, now) => {
  const latest = await Organization.findById(orgId);
  if (!latest) {
    const err = new Error('Organization not found');
    err.statusCode = 404;
    throw err;
  }
  const latestAccess = billingAccessForOrganization(latest, now);
  if (!latestAccess.allowed) throw billingRequiredError(latestAccess);
  throw insufficientCreditsError(creditSnapshot(latest, now), requested);
};

const reserveGuavaCredits = async (orgId, amount = 1) => {
  const requested = normalizeCreditAmount(amount);
  const now = new Date();
  const current = await refreshCreditWindow(orgId, now);
  const access = billingAccessForOrganization(current, now);
  if (!access.allowed) throw billingRequiredError(access);
  if (requested === 0) return { org: current, credits: creditSnapshot(current, now) };

  const reservation = await reserveCreditsAtomic(orgId, requested, now);

  if (!reservation) {
    await throwCreditReservationError(orgId, requested, now);
  }

  return {
    org: reservation.org,
    credits: creditSnapshot(reservation.org, now),
    creditAllocation: reservation.allocation,
  };
};

const normalizeCreditAllocation = (allocation, fallbackCredits = 0) => {
  const total = normalizeCreditAmount(fallbackCredits);
  const included = Math.min(total, normalizeCreditAmount(allocation?.included));
  const bonus = Math.min(total - included, normalizeCreditAmount(allocation?.bonus));
  if (allocation && included + bonus === total) return { included, bonus };
  return { included: total, bonus: 0 };
};

const creditRefundPipeline = ({ allocation, expectedResetAt, conditionalIncluded = false }) => {
  const includedRefund = conditionalIncluded && expectedResetAt
    ? {
        $cond: [
          { $eq: ['$aiCredits.resetAt', expectedResetAt] },
          allocation.included,
          0,
        ],
      }
    : allocation.included;
  const totalRefund = { $add: [includedRefund, allocation.bonus] };
  const nextUsed = {
    $max: [0, { $subtract: [mongoEffectiveUsedCredits(), totalRefund] }],
  };
  const nextBonusUsed = {
    $min: [
      nextUsed,
      {
        $max: [
          0,
          { $subtract: [mongoBonusUsedCredits(), allocation.bonus] },
        ],
      },
    ],
  };

  return [
    {
      $set: {
        'aiCredits.used': nextUsed,
        'aiCredits.bonusUsed': nextBonusUsed,
        __v: { $add: [{ $ifNull: ['$__v', 0] }, 1] },
      },
    },
  ];
};

const refundGuavaCredits = async (
  orgId,
  amount = 1,
  { resetAt, creditAllocation } = {}
) => {
  const refunded = normalizeCreditAmount(amount);
  const expectedResetAt = asDate(resetAt);
  const allocation = normalizeCreditAllocation(creditAllocation, refunded);
  const org = await Organization.findOneAndUpdate(
    {
      _id: orgId,
      ...(expectedResetAt ? { 'aiCredits.resetAt': expectedResetAt } : {}),
    },
    creditRefundPipeline({ allocation }),
    { new: true }
  );
  return org ? creditSnapshot(org) : null;
};

const cleanIdempotencyKey = (value) => {
  const key = String(value || '').trim();
  return key ? key.slice(0, 160) : undefined;
};

const usageRequestFingerprint = (payload) => {
  const relatedKind = String(payload.relatedEntity?.kind || '');
  const relatedId = String(payload.relatedEntity?.id || '');
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      orgId: String(payload.orgId || ''),
      cafeId: String(payload.cafeId || ''),
      userId: String(payload.userId || ''),
      featureKey: String(payload.featureKey || ''),
      credits: normalizeCreditAmount(payload.credits),
      semanticHash: String(payload.metadata?.semanticHash || '') || null,
      relatedEntity: relatedKind || relatedId
        ? { kind: relatedKind, id: relatedId }
        : null,
    }))
    .digest('hex');
};

const usageReplayError = (ledger) => {
  const err = new Error('This Guava Credit request has already been processed');
  err.statusCode = 409;
  err.details = {
    code: 'USAGE_IDEMPOTENCY_CONFLICT',
    status: ledger?.status || 'unknown',
  };
  return err;
};

const hasStoredResult = (ledger) =>
  ledger && ledger.get('resultPayload') !== undefined;

const splitMeteredRunResult = (rawResult) => {
  if (
    !rawResult ||
    typeof rawResult !== 'object' ||
    Array.isArray(rawResult) ||
    !Object.prototype.hasOwnProperty.call(rawResult, USAGE_DIAGNOSTICS_FIELD)
  ) {
    return { result: rawResult, providerDiagnostics: undefined };
  }

  const {
    [USAGE_DIAGNOSTICS_FIELD]: providerDiagnostics,
    ...result
  } = rawResult;
  return { result, providerDiagnostics };
};

const withUsageDiagnostics = (result, providerDiagnostics) => {
  if (!providerDiagnostics || !result || typeof result !== 'object' || Array.isArray(result)) {
    return result;
  }
  return {
    ...result,
    [USAGE_DIAGNOSTICS_FIELD]: providerDiagnostics,
  };
};

const aiPolicyError = (code, message, details) => {
  const error = new Error(message);
  error.statusCode = 429;
  error.code = code;
  error.details = { code, ...details };
  return error;
};

const enforceAiUsagePolicy = async ({ orgId, userId, featureKey, credits }, session) => {
  if (!AI_FEATURE_KEYS.has(featureKey)) return;
  const limits = aiUsagePolicy();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const activeStatuses = ['reserved', 'recovering'];
  const policyOrgId = mongoose.Types.ObjectId.isValid(orgId)
    ? new mongoose.Types.ObjectId(orgId)
    : orgId;
  const policyUserId = mongoose.Types.ObjectId.isValid(userId)
    ? new mongoose.Types.ObjectId(userId)
    : userId;

  const [userDaily, orgDaily, userConcurrent, orgConcurrent] = await Promise.all([
    UsageLedger.aggregate([
      {
        $match: {
          orgId: policyOrgId,
          userId: policyUserId,
          featureKey: { $in: [...AI_FEATURE_KEYS] },
          status: { $in: ['reserved', 'recovering', 'committed'] },
          // An $expr over a computed field cannot use an index, so this used to
          // scan every ledger row the organisation had ever written -- inside
          // the reservation transaction, on every paid AI request. The $or is
          // the same 24-hour window as an indexable range plus a legacy branch
          // for rows written before reservedAt existed.
          $or: [
            { reservedAt: { $gte: since } },
            { reservedAt: null, createdAt: { $gte: since } },
          ],
        },
      },
      { $group: { _id: null, credits: { $sum: '$credits' } } },
    ]).session(session),
    UsageLedger.aggregate([
      {
        $match: {
          orgId: policyOrgId,
          featureKey: { $in: [...AI_FEATURE_KEYS] },
          status: { $in: ['reserved', 'recovering', 'committed'] },
          // An $expr over a computed field cannot use an index, so this used to
          // scan every ledger row the organisation had ever written -- inside
          // the reservation transaction, on every paid AI request. The $or is
          // the same 24-hour window as an indexable range plus a legacy branch
          // for rows written before reservedAt existed.
          $or: [
            { reservedAt: { $gte: since } },
            { reservedAt: null, createdAt: { $gte: since } },
          ],
        },
      },
      { $group: { _id: null, credits: { $sum: '$credits' } } },
    ]).session(session),
    UsageLedger.countDocuments({
      orgId: policyOrgId,
      userId: policyUserId,
      featureKey: { $in: [...AI_FEATURE_KEYS] },
      status: { $in: activeStatuses },
    }).session(session),
    UsageLedger.countDocuments({
      orgId: policyOrgId,
      featureKey: { $in: [...AI_FEATURE_KEYS] },
      status: { $in: activeStatuses },
    }).session(session),
  ]);

  const userUsed = Number(userDaily[0]?.credits) || 0;
  const orgUsed = Number(orgDaily[0]?.credits) || 0;
  if (userUsed + credits > limits.userDailyCredits) {
    throw aiPolicyError(
      'AI_USER_DAILY_BUDGET_REACHED',
      'Your daily AI credit safety limit has been reached',
      { limit: limits.userDailyCredits, used: userUsed, required: credits }
    );
  }
  if (orgUsed + credits > limits.orgDailyCredits) {
    throw aiPolicyError(
      'AI_ORG_DAILY_BUDGET_REACHED',
      'The organization daily AI credit safety limit has been reached',
      { limit: limits.orgDailyCredits, used: orgUsed, required: credits }
    );
  }
  if (userConcurrent >= limits.userConcurrency) {
    throw aiPolicyError(
      'AI_USER_CONCURRENCY_LIMIT',
      'You already have the maximum number of AI requests in progress',
      { limit: limits.userConcurrency }
    );
  }
  if (orgConcurrent >= limits.orgConcurrency) {
    throw aiPolicyError(
      'AI_ORG_CONCURRENCY_LIMIT',
      'The organization already has the maximum number of AI requests in progress',
      { limit: limits.orgConcurrency }
    );
  }
};

const createMeteredReservation = async ({ idempotencyKey, credits, ...payload }) => {
  const key = cleanIdempotencyKey(idempotencyKey);
  const requestFingerprint = usageRequestFingerprint({ credits, ...payload });
  const now = new Date();
  const current = await refreshCreditWindow(payload.orgId, now);
  const access = billingAccessForOrganization(current, now);
  if (!access.allowed) throw billingRequiredError(access);

  const session = await mongoose.startSession();
  let ledger;
  let reservedOrg;
  let creditAllocation;
  let replayed = false;
  let replayResult;
  try {
    await session.withTransaction(async () => {
      let existing = null;
      if (key) {
        existing = await UsageLedger.findOne({
          orgId: payload.orgId,
          idempotencyKey: key,
        }).session(session);
      }

      if (existing) {
        const existingFingerprint = existing.requestFingerprint || usageRequestFingerprint(existing);
        if (existingFingerprint !== requestFingerprint) {
          const conflict = usageReplayError(existing);
          conflict.details.code = 'USAGE_IDEMPOTENCY_FINGERPRINT_CONFLICT';
          throw conflict;
        }
        if (existing.status === 'committed' && hasStoredResult(existing)) {
          ledger = existing;
          replayed = true;
          replayResult = existing.resultPayload;
          reservedOrg = await Organization.findById(payload.orgId).session(session);
          return;
        }
        if (existing.status !== 'refunded') throw usageReplayError(existing);

        await enforceAiUsagePolicy(
          {
            orgId: payload.orgId,
            userId: payload.userId,
            featureKey: payload.featureKey,
            credits,
          },
          session
        );
        ledger = await UsageLedger.findOneAndUpdate(
          { _id: existing._id, status: 'refunded' },
          {
            $set: {
              ...payload,
              credits,
              status: 'reserved',
              requestFingerprint,
              reservedAt: now,
            },
            $unset: { completedAt: 1, recoveryReason: 1 },
            $inc: { replayCount: 1 },
          },
          { new: true, session, runValidators: true }
        );
        if (!ledger) throw usageReplayError(existing);
      } else {
        await enforceAiUsagePolicy(
          {
            orgId: payload.orgId,
            userId: payload.userId,
            featureKey: payload.featureKey,
            credits,
          },
          session
        );
        [ledger] = await UsageLedger.create(
          [{
            ...payload,
            credits,
            status: 'reserved',
            idempotencyKey: key,
            requestFingerprint,
            reservedAt: now,
          }],
          { session }
        );
      }

      if (replayed) return;

      const reservation = await reserveCreditsAtomic(payload.orgId, credits, now, session);
      if (!reservation) {
        const error = new Error('Guava Credit reservation rejected');
        error.code = 'CREDIT_RESERVATION_REJECTED';
        throw error;
      }
      reservedOrg = reservation.org;
      creditAllocation = reservation.allocation;

      const creditWindowResetAt = asDate(reservedOrg.aiCredits?.resetAt);
      const captured = await UsageLedger.updateOne(
        { _id: ledger._id, status: 'reserved' },
        { $set: { creditWindowResetAt, creditAllocation } },
        { session }
      );
      if (captured.matchedCount !== 1) {
        throw new Error('Could not capture the Guava Credit reservation window');
      }
      ledger.creditWindowResetAt = creditWindowResetAt;
      ledger.creditAllocation = creditAllocation;
    });
  } catch (error) {
    if (error.code === 11000 && key) {
      const existing = await UsageLedger.findOne({
        orgId: payload.orgId,
        idempotencyKey: key,
      }).lean();
      throw usageReplayError(existing);
    }
    if (error.code === 'CREDIT_RESERVATION_REJECTED') {
      await throwCreditReservationError(payload.orgId, credits, now);
    }
    throw error;
  } finally {
    await session.endSession();
  }

  return {
    ledger,
    credits: creditSnapshot(reservedOrg, now),
    creditWindowResetAt: asDate(reservedOrg.aiCredits?.resetAt),
    creditAllocation,
    replayed,
    replayResult,
  };
};

const finishUsage = (ledger, status, { resultPayload, providerDiagnostics } = {}) =>
  UsageLedger.findOneAndUpdate(
    { _id: ledger._id, status: 'reserved' },
    {
      $set: {
        status,
        completedAt: new Date(),
        ...(resultPayload !== undefined ? { resultPayload } : {}),
        ...(providerDiagnostics !== undefined ? { providerDiagnostics } : {}),
      },
    },
    { new: true }
  );

/**
 * Commits a reservation the stale-reservation reconciler already refunded.
 *
 * A run that outlives its lease still cost real provider money, and on the SSE
 * path its answer is already on the customer's screen, so discarding it is the
 * worst available outcome -- the reserved-only commit filter used to throw the
 * answer away and leave the idempotency key pointing at a refunded row, making
 * the client's retry pay for the whole generation again. The row is claimed
 * first and the credits taken back afterwards, so the charge can never be
 * applied to a row this worker does not own.
 */
const commitAfterLeaseBreach = async (ledger, orgId, { resultPayload, providerDiagnostics }) => {
  const claimed = await UsageLedger.findOneAndUpdate(
    { _id: ledger._id, status: 'refunded', recoveryReason: 'stale_reservation' },
    {
      $set: {
        status: 'committed',
        completedAt: new Date(),
        recoveryReason: 'lease_breach_recommitted',
        ...(resultPayload !== undefined ? { resultPayload } : {}),
        ...(providerDiagnostics !== undefined ? { providerDiagnostics } : {}),
      },
    },
    { new: true }
  );
  if (!claimed) return null;

  console.warn(
    `[usage] reservation ${claimed._id} outlived its lease and was recommitted for org ${orgId}`
  );
  const recharge = await reserveCreditsAtomic(orgId, claimed.credits, new Date());
  if (!recharge) {
    // The answer was delivered, so the row stays committed. Recording that the
    // credits could not be taken again keeps the ledger honest.
    return UsageLedger.findOneAndUpdate(
      { _id: claimed._id, status: 'committed' },
      { $set: { recoveryReason: 'lease_breach_uncharged' } },
      { new: true }
    );
  }
  return UsageLedger.findOneAndUpdate(
    { _id: claimed._id, status: 'committed' },
    {
      $set: {
        creditAllocation: recharge.allocation,
        creditWindowResetAt: asDate(recharge.org.aiCredits?.resetAt),
      },
    },
    { new: true }
  );
};

const refundAndFinishUsage = async ({
  ledger,
  orgId,
  credits,
  creditWindowResetAt,
  creditAllocation,
}) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const expectedResetAt = asDate(creditWindowResetAt);
      const allocation = normalizeCreditAllocation(
        creditAllocation || ledger?.creditAllocation,
        credits
      );
      await Organization.findOneAndUpdate(
        { _id: orgId },
        creditRefundPipeline({
          allocation,
          expectedResetAt,
          conditionalIncluded: true,
        }),
        { new: true, session }
      );

      const finished = await UsageLedger.updateOne(
        { _id: ledger._id, status: 'reserved' },
        {
          $set: {
            status: 'refunded',
            recoveryReason: 'operation_failed',
            completedAt: new Date(),
          },
        },
        { session }
      );
      if (finished.matchedCount !== 1) {
        throw new Error('Could not finalize refunded Guava Credit usage');
      }
    });
  } finally {
    await session.endSession();
  }
};

const recoverStaleUsageReservation = async (ledgerId, staleBefore) => {
  const session = await mongoose.startSession();
  let recovered = false;
  try {
    await session.withTransaction(async () => {
      const ledger = await UsageLedger.findOneAndUpdate(
        {
          _id: ledgerId,
          status: 'reserved',
          $or: [
            { reservedAt: { $lte: staleBefore } },
            { reservedAt: { $exists: false }, createdAt: { $lte: staleBefore } },
          ],
        },
        { $set: { status: 'recovering' } },
        { new: true, session }
      );
      if (!ledger) return;

      const allocation = normalizeCreditAllocation(ledger.creditAllocation, ledger.credits);
      await Organization.findOneAndUpdate(
        { _id: ledger.orgId },
        creditRefundPipeline({
          allocation,
          expectedResetAt: asDate(ledger.creditWindowResetAt),
          conditionalIncluded: true,
        }),
        { new: true, session }
      );
      const finished = await UsageLedger.updateOne(
        { _id: ledger._id, status: 'recovering' },
        {
          $set: {
            status: 'refunded',
            recoveryReason: 'stale_reservation',
            completedAt: new Date(),
          },
        },
        { session }
      );
      if (finished.matchedCount !== 1) {
        throw new Error('Could not finalize stale Guava Credit reservation');
      }
      recovered = true;
    });
  } finally {
    await session.endSession();
  }
  return recovered;
};

const reconcileStaleUsageReservations = async ({
  now = new Date(),
  leaseMs = DEFAULT_USAGE_RESERVATION_LEASE_MS,
  limit = DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE,
  concurrency = 4,
} = {}) => {
  const boundedLeaseMs = Math.max(60_000, Number(leaseMs) || DEFAULT_USAGE_RESERVATION_LEASE_MS);
  const boundedLimit = Math.max(
    1,
    Math.min(Number(limit) || DEFAULT_USAGE_RECONCILIATION_BATCH_SIZE, 200)
  );
  const boundedConcurrency = Math.max(1, Math.min(Number(concurrency) || 4, 10));
  const staleBefore = new Date(now.getTime() - boundedLeaseMs);
  const candidates = await UsageLedger.find({
    status: 'reserved',
    $or: [
      { reservedAt: { $lte: staleBefore } },
      { reservedAt: { $exists: false }, createdAt: { $lte: staleBefore } },
    ],
  })
    .sort({ reservedAt: 1, _id: 1 })
    .limit(boundedLimit)
    .select('_id')
    .lean();

  const summary = { scanned: candidates.length, refunded: 0, skipped: 0, errors: 0 };
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor;
      cursor += 1;
      try {
        if (await recoverStaleUsageReservation(candidates[index]._id, staleBefore)) {
          summary.refunded += 1;
        } else {
          summary.skipped += 1;
        }
      } catch (_error) {
        summary.errors += 1;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(boundedConcurrency, candidates.length) }, () => worker())
  );
  return summary;
};

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
  idempotencyKey,
  signal,
  run,
}) => {
  const config = FEATURE_COSTS[featureKey] || {};
  const requested = credits ?? config.credits ?? 1;
  // normalizeCreditAmount maps anything unparseable to 0, and 0 takes the
  // unmetered path below: no billing check, no reservation and no ledger row.
  // A bad amount must fail loudly rather than quietly give the paid product away.
  const requestedNumber = Number(requested);
  if (!Number.isFinite(requestedNumber) || requestedNumber < 0) {
    const err = new Error('A non-negative Guava Credit amount is required');
    err.statusCode = 400;
    err.code = 'INVALID_CREDIT_AMOUNT';
    throw err;
  }
  const amount = normalizeCreditAmount(requestedNumber);

  if (amount === 0) {
    // A zero-cost feature is still part of the paid product, so it stays behind
    // the same paywall even though there is nothing to charge for it.
    const current = await refreshCreditWindow(orgId);
    const access = billingAccessForOrganization(current);
    if (!access.allowed) throw billingRequiredError(access);
    const result = await run();
    const org = await Organization.findById(orgId);
    return { result, guavaCredits: org ? creditSnapshot(org) : null, usage: null };
  }

  const reservation = await createMeteredReservation({
    orgId,
    cafeId,
    userId,
    featureKey,
    credits: amount,
    provider: provider || config.provider || 'guava',
    label: label || config.label || featureKey,
    relatedEntity,
    metadata,
    idempotencyKey,
  });
  const {
    ledger,
    creditWindowResetAt,
    creditAllocation,
    replayed,
    replayResult,
  } = reservation;

  if (replayed) {
    return {
      result: replayResult,
      guavaCredits: reservation.credits,
      usage: ledger,
      replayed: true,
    };
  }

  let runCompleted = false;
  let completedResult;
  let completedProviderDiagnostics;
  try {
    const rawResult = await run();
    const { result, providerDiagnostics } = splitMeteredRunResult(rawResult);
    completedResult = result;
    completedProviderDiagnostics = providerDiagnostics;
    if (signal?.aborted) {
      const abortError = signal.reason instanceof Error
        ? signal.reason
        : new Error('Operation aborted');
      abortError.name = 'AbortError';
      throw abortError;
    }
    runCompleted = true;
    const committed = await finishUsage(ledger, 'committed', {
      resultPayload: result,
      providerDiagnostics,
    }) || await commitAfterLeaseBreach(ledger, orgId, {
      resultPayload: result,
      providerDiagnostics,
    });
    if (!committed) throw new Error('Could not commit Guava Credit usage');
    const org = await Organization.findById(orgId);
    return {
      result,
      guavaCredits: creditSnapshot(org),
      usage: committed,
      replayed: false,
    };
  } catch (error) {
    if (!runCompleted) {
      await refundAndFinishUsage({
        ledger,
        orgId,
        credits: amount,
        creditWindowResetAt,
        creditAllocation,
      }).catch(() => null);
    } else {
      // Preserve the delivered provider result during commit recovery. A
      // status-only recovery would charge successfully but make a retry
      // impossible to replay, recreating the paid-without-an-answer failure.
      await finishUsage(ledger, 'committed', {
        resultPayload: completedResult,
        providerDiagnostics: completedProviderDiagnostics,
      })
        .then((settled) => settled || commitAfterLeaseBreach(ledger, orgId, {
          resultPayload: completedResult,
          providerDiagnostics: completedProviderDiagnostics,
        }))
        .catch(() => null);
    }
    throw error;
  }
};

const consumeGuavaCredits = async (orgId, amount = 1, options = {}) => {
  const { guavaCredits } = await meterGuavaCredits({
    orgId,
    credits: amount,
    featureKey: options.featureKey || 'manual',
    label: options.label || 'Manual credit usage',
    provider: options.provider,
    cafeId: options.cafeId,
    userId: options.userId,
    relatedEntity: options.relatedEntity,
    metadata: options.metadata,
    idempotencyKey: options.idempotencyKey,
    run: async () => null,
  });
  return guavaCredits;
};

const usageSummary = async (orgId, { limit = 12 } = {}) => {
  // setMonth overflows on a long month -- 31 March minus one month lands on 3
  // March -- which silently dropped the first days of the window it claims to
  // cover. The clamped helper is the same arithmetic the billing periods use.
  const since = addUtcMonthsClamped(new Date(), -1);

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
    // Only settled charges are activity. Reserved/refunded rows are credit
    // holds that were (or will be) released, and the portal renders whatever
    // is returned here as spend.
    UsageLedger.find({ orgId, status: 'committed' })
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
  billingAccessForOrganization,
  billingRequiredError,
  bonusUsedForCredits,
  consumeGuavaCredits,
  creditSnapshot,
  ensureFreshCreditWindow,
  meterGuavaCredits,
  reconcileStaleUsageReservations,
  refreshCreditWindow,
  refundGuavaCredits,
  reserveGuavaCredits,
  usageSummary,
  withUsageDiagnostics,
};
