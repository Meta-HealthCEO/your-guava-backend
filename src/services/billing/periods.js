// Plan-period maths for a payment, and the forecast invalidation a plan change triggers.
// Moved from billingPayments.service.js by BE-11-T04; behaviour unchanged.
const Cafe = require('../../models/Cafe.model');
const Forecast = require('../../models/Forecast.model');
const { addBillingCycle } = require('../billingPlans.service');
const { zonedDayStart, safeTimezone } = require('../../utils/timezone');

const invalidateFutureForecastsForOrg = async (orgId) => {
  const cafes = await Cafe.find({ orgId }).select('_id timezone').lean();
  if (cafes.length === 0) return;

  const now = new Date();

  await Forecast.deleteMany({
    $or: cafes.map((cafe) => ({
      cafeId: cafe._id,
      date: { $gte: zonedDayStart(now, safeTimezone(cafe.timezone)) },
    })),
  });
};

const billingPeriodForPayment = (org, billingCycle = 'monthly', now = new Date()) => {
  const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
  const existingEnd = org?.currentPeriodEnd ? new Date(org.currentPeriodEnd) : null;
  const isRenewal =
    org?.billingStatus === 'active' &&
    org?.billingCycle === cycle &&
    existingEnd &&
    existingEnd > now;
  const extensionStart = isRenewal ? existingEnd : now;

  return {
    billingCycle: cycle,
    currentPeriodStart: isRenewal && org.currentPeriodStart
      ? new Date(org.currentPeriodStart)
      : new Date(now),
    currentPeriodEnd: addBillingCycle(extensionStart, cycle),
  };
};

module.exports = {
  invalidateFutureForecastsForOrg, billingPeriodForPayment,
};
