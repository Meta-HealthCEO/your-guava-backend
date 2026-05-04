const PLAN_CONFIG = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 399,
    priceAnnual: 3990,
    includedSeats: 2,
    includedAiCredits: 150,
    includedLocations: 2,
    overagePerSeat: 120,
    aiCreditPackPrice: 99,
    features: [
      'CSV imports and 7-day forecasts',
      'AI insights chat',
      '2 cafe locations',
      'Basic analytics',
    ],
  },
  growth: {
    id: 'growth',
    name: 'Growth',
    priceMonthly: 899,
    priceAnnual: 8990,
    includedSeats: 6,
    includedAiCredits: 600,
    includedLocations: 3,
    overagePerSeat: 100,
    aiCreditPackPrice: 89,
    features: [
      'Multi-location forecasting',
      'Team roles and location access',
      'Advanced analytics',
      'Priority AI context windows',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 1799,
    priceAnnual: 17990,
    includedSeats: 15,
    includedAiCredits: 2000,
    includedLocations: 10,
    overagePerSeat: 80,
    aiCreditPackPrice: 69,
    features: [
      '10 locations included',
      'Higher AI credit allowance',
      'Forecast audit trails',
      'Priority support',
    ],
  },
};

const normalisePlanId = (plan) => (PLAN_CONFIG[plan] ? plan : 'starter');

const getPlan = (plan) => PLAN_CONFIG[normalisePlanId(plan)];

const getPlans = () => Object.values(PLAN_CONFIG);

const nextCreditResetDate = () => {
  const resetAt = new Date();
  resetAt.setMonth(resetAt.getMonth() + 1);
  resetAt.setDate(1);
  resetAt.setHours(0, 0, 0, 0);
  return resetAt;
};

module.exports = { PLAN_CONFIG, getPlan, getPlans, normalisePlanId, nextCreditResetDate };
