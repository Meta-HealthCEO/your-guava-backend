const PLAN_CONFIG = {
  starter: {
    id: 'starter',
    name: 'Starter',
    priceMonthly: 399,
    priceAnnual: 3990,
    includedSeats: 2,
    includedAiCredits: 150,
    includedGuavaCredits: 400,
    includedLocations: 2,
    overagePerSeat: 120,
    aiCreditPackPrice: 99,
    guavaCreditPackPrice: 99,
    creditPackOptions: [
      { credits: 500, price: 99 },
      { credits: 1500, price: 249 },
      { credits: 5000, price: 699 },
    ],
    features: [
      'CSV imports and 7-day forecasts',
      'Weather and holiday forecast factors',
      '400 Guava Credits for AI and data checks',
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
    includedGuavaCredits: 1800,
    includedLocations: 3,
    overagePerSeat: 100,
    aiCreditPackPrice: 89,
    guavaCreditPackPrice: 89,
    creditPackOptions: [
      { credits: 500, price: 89 },
      { credits: 1500, price: 229 },
      { credits: 5000, price: 649 },
    ],
    features: [
      'Multi-location forecasting',
      'Events, payday, load shedding, and stock buffer factors',
      'Team roles and location access',
      'Advanced analytics',
      '1,800 Guava Credits for AI and data checks',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 1799,
    priceAnnual: 17990,
    includedSeats: 15,
    includedAiCredits: 2000,
    includedGuavaCredits: 6000,
    includedLocations: 10,
    overagePerSeat: 80,
    aiCreditPackPrice: 69,
    guavaCreditPackPrice: 69,
    creditPackOptions: [
      { credits: 500, price: 69 },
      { credits: 1500, price: 199 },
      { credits: 5000, price: 599 },
    ],
    features: [
      '10 locations included',
      'Learning correction and advanced history weighting',
      '6,000 Guava Credits for AI and data checks',
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
