const User = require('../models/User.model');
const Cafe = require('../models/Cafe.model');
const TeamInvitation = require('../models/TeamInvitation.model');
const { getPlan } = require('./billingPlans.service');

const withSession = (query, session) => (session ? query.session(session) : query);

const getPlanCapacity = async (orgId, planId, { session } = {}) => {
  const now = new Date();
  const plan = getPlan(planId);
  const [activeSeats, pendingSeats, locations] = await Promise.all([
    withSession(User.countDocuments({ orgId }), session),
    withSession(
      TeamInvitation.countDocuments({
        orgId,
        status: 'pending',
        expiresAt: { $gt: now },
      }),
      session
    ),
    withSession(Cafe.countDocuments({ orgId }), session),
  ]);
  const seats = activeSeats + pendingSeats;

  return {
    plan: plan.id,
    seats: {
      used: seats,
      active: activeSeats,
      pending: pendingSeats,
      included: plan.includedSeats,
      exceeded: seats > plan.includedSeats,
    },
    locations: {
      used: locations,
      included: plan.includedLocations,
      exceeded: locations > plan.includedLocations,
    },
  };
};

const planCapacityError = (capacity) => {
  const limits = [];
  if (capacity.seats.exceeded) {
    limits.push(`${capacity.seats.used} team seats (limit ${capacity.seats.included})`);
  }
  if (capacity.locations.exceeded) {
    limits.push(`${capacity.locations.used} locations (limit ${capacity.locations.included})`);
  }

  const error = new Error(
    `Reduce usage before switching to the ${capacity.plan} plan: ${limits.join(' and ')}`
  );
  error.statusCode = 409;
  error.code = 'PLAN_LIMIT_EXCEEDED';
  error.details = { code: error.code, capacity };
  return error;
};

const assertPlanCapacity = async (orgId, planId, options) => {
  const capacity = await getPlanCapacity(orgId, planId, options);
  if (capacity.seats.exceeded || capacity.locations.exceeded) {
    throw planCapacityError(capacity);
  }
  return capacity;
};

const assertPlanChangeCapacity = async (orgId, currentPlanId, nextPlanId, options) => {
  const currentPlan = getPlan(currentPlanId);
  const nextPlan = getPlan(nextPlanId);
  const reducesCapacity =
    nextPlan.includedSeats < currentPlan.includedSeats ||
    nextPlan.includedLocations < currentPlan.includedLocations;
  if (!reducesCapacity) return null;
  return assertPlanCapacity(orgId, nextPlan.id, options);
};

module.exports = {
  assertPlanCapacity,
  assertPlanChangeCapacity,
  getPlanCapacity,
  planCapacityError,
};
