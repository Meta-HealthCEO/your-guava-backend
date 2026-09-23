// Metering: feature costs, the diagnostics field, meterGuavaCredits and consumeGuavaCredits.
// Moved from usage.service.js by BE-11-T04; behaviour unchanged.
const Organization = require('../../models/Organization.model');
const { billingAccessForOrganization, billingRequiredError } = require('./policy');
const { normalizeCreditAmount, refreshCreditWindow, creditSnapshot } = require('./credits');
const { createMeteredReservation, finishUsage, commitAfterLeaseBreach, refundAndFinishUsage } = require('./ledger');

const FEATURE_COSTS = {
  ask_guava_chat: { credits: 3, label: 'Ask Guava answer', provider: 'anthropic' },
  import_column_mapping: { credits: 10, label: 'AI import column mapping', provider: 'anthropic' },
  menu_item_ai_review: { credits: 1, label: 'Menu item AI review', provider: 'anthropic' },
  insight_refresh: { credits: 10, label: 'AI insight refresh', provider: 'anthropic' },
  history_backfill_day: { credits: 1, label: 'Historical forecast backfill day', provider: 'weather' },
};

const USAGE_DIAGNOSTICS_FIELD = '__usageDiagnostics';

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

module.exports = {
  FEATURE_COSTS, USAGE_DIAGNOSTICS_FIELD, withUsageDiagnostics, meterGuavaCredits, consumeGuavaCredits,
};
