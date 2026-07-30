const {
  DEFAULT_FORECAST_SETTINGS,
  getFactorEntitlements,
  getForecastSettings,
  normalizeForecastSettings,
  buildGlobalFactors,
  buildItemFactors,
  multiplyFactors,
  eventImpactPct,
} = require('../../src/services/forecastFactors.service');

describe('forecast factors', () => {
  const baseSignals = {
    loadSheddingStage: 0,
    isPublicHoliday: false,
    isSchoolHoliday: false,
    isPayday: false,
  };

  it('preserves the default recent-week history weights', () => {
    const settings = normalizeForecastSettings();

    expect(settings.history.recentWeights).toEqual([0.35, 0.25, 0.20]);
    expect(settings.history.twoWeekWeights).toEqual([0.6, 0.4]);
  });

  it('keeps default weather behaviour for hot, cold, and rainy days', () => {
    const settings = normalizeForecastSettings();

    const hotColdDrink = buildItemFactors({
      category: 'cold_drink',
      signals: baseSignals,
      weather: { temp: 30, condition: 'Sunny', isRain: false },
      events: [],
      settings,
    });
    expect(hotColdDrink.find((f) => f.key === 'weather').multiplier).toBeCloseTo(1.30, 2);

    const hotCoffee = buildItemFactors({
      category: 'coffee',
      signals: baseSignals,
      weather: { temp: 30, condition: 'Sunny', isRain: false },
      events: [],
      settings,
    });
    expect(hotCoffee.find((f) => f.key === 'weather').multiplier).toBeCloseTo(0.90, 2);

    const coldRain = buildItemFactors({
      category: 'cold_drink',
      signals: baseSignals,
      weather: { temp: 12, condition: 'Rain', isRain: true },
      events: [],
      settings,
    });
    expect(coldRain.find((f) => f.key === 'weather').multiplier).toBeCloseTo(0.70, 2);
  });

  it('keeps weather factors neutral when weather is explicitly unavailable', () => {
    const settings = normalizeForecastSettings({ payday: { pct: 10 } });
    const weather = {
      available: false,
      temp: 35,
      condition: 'Rain',
      isRain: true,
      unavailableReason: 'Cafe coordinates are not configured',
    };

    const itemFactors = buildItemFactors({
      category: 'cold_drink',
      signals: { ...baseSignals, isPayday: true },
      weather,
      events: [],
      settings,
    });
    const itemWeather = itemFactors.find((factor) => factor.key === 'weather');
    expect(itemWeather).toEqual(expect.objectContaining({
      active: false,
      adjustmentPct: 0,
      multiplier: 1,
      reason: 'Cafe coordinates are not configured',
    }));
    expect(multiplyFactors(itemFactors)).toBeCloseTo(1.10, 2);

    const summaryWeather = buildGlobalFactors({
      signals: baseSignals,
      weather,
      events: [],
      settings,
    }).find((factor) => factor.key === 'weather');
    expect(summaryWeather).toEqual(expect.objectContaining({
      active: false,
      multiplier: 1,
      reason: 'Cafe coordinates are not configured',
    }));
  });

  it('keeps default load shedding, holiday, payday, and event weights', () => {
    const settings = normalizeForecastSettings();
    const factors = buildGlobalFactors({
      signals: {
        loadSheddingStage: 5,
        isPublicHoliday: true,
        isSchoolHoliday: true,
        isPayday: true,
      },
      weather: { temp: 22, condition: 'Clear', isRain: false },
      events: [{ name: 'Market', impact: 'high' }],
      settings,
    });

    expect(factors.find((f) => f.key === 'loadShedding').multiplier).toBeCloseTo(0.60, 2);
    expect(factors.find((f) => f.key === 'holiday').multiplier).toBeCloseTo(1.20, 2);
    expect(factors.find((f) => f.key === 'payday').multiplier).toBeCloseTo(1.20, 2);
    expect(factors.find((f) => f.key === 'events').multiplier).toBeCloseTo(1.35, 2);
  });

  it('keeps load-shedding factors neutral when the stage is unknown', () => {
    const settings = normalizeForecastSettings();
    const factors = buildItemFactors({
      category: 'coffee',
      signals: {
        ...baseSignals,
        loadSheddingStage: null,
        loadSheddingAvailable: false,
        loadSheddingUnavailableReason: 'Load-shedding data is temporarily unavailable',
      },
      weather: { available: true, temp: 22, condition: 'Clear', isRain: false },
      events: [],
      settings,
    });

    expect(factors.find((factor) => factor.key === 'loadShedding')).toEqual(
      expect.objectContaining({
        active: false,
        adjustmentPct: 0,
        multiplier: 1,
        reason: 'Load-shedding data is temporarily unavailable',
      })
    );
    expect(multiplyFactors(factors)).toBe(1);
  });

  it('gates effective factor settings by subscription plan', () => {
    const cafe = {
      forecastSettings: normalizeForecastSettings({
        events: { enabled: true, highPct: 50 },
        payday: { enabled: true, pct: 12 },
        stock: { safetyMarginPct: 25, maxBiasPct: 40 },
        history: { maxWeeks: 12 },
        learning: { enabled: true },
      }),
    };

    const starter = getForecastSettings(cafe, 'starter');
    expect(starter.events.enabled).toBe(false);
    expect(starter.payday.enabled).toBe(false);
    expect(starter.stock.safetyMarginPct).toBe(0);
    expect(starter.history.maxWeeks).toBe(DEFAULT_FORECAST_SETTINGS.history.maxWeeks);
    expect(starter.learning.enabled).toBe(false);

    const growth = getForecastSettings(cafe, 'growth');
    expect(growth.events.enabled).toBe(true);
    expect(growth.events.highPct).toBe(50);
    expect(growth.payday.pct).toBe(12);
    expect(growth.stock.safetyMarginPct).toBe(25);
    expect(growth.learning.enabled).toBe(false);

    const pro = getForecastSettings(cafe, 'pro');
    expect(pro.history.maxWeeks).toBe(12);
    expect(pro.learning.enabled).toBe(true);
  });

  it('returns factor entitlements for the current plan', () => {
    const entitlements = getFactorEntitlements('growth');

    expect(entitlements.unlockedKeys).toEqual(
      expect.arrayContaining(['weather', 'holiday', 'payday', 'events', 'loadShedding', 'stock'])
    );
    expect(entitlements.lockedKeys).toEqual(expect.arrayContaining(['history', 'learning']));
  });

  it('applies cafe-specific factor overrides', () => {
    const settings = normalizeForecastSettings({
      payday: { pct: 12 },
      events: { highPct: 50 },
    });

    const factors = buildGlobalFactors({
      signals: { ...baseSignals, isPayday: true },
      weather: { temp: 22, condition: 'Clear', isRain: false },
      events: [{ name: 'Derby Day', impact: 'high' }],
      settings,
    });

    expect(factors.find((f) => f.key === 'payday').multiplier).toBeCloseTo(1.12, 2);
    expect(factors.find((f) => f.key === 'events').multiplier).toBeCloseTo(1.50, 2);
  });

  it('lets a local event carry an explicit weighting', () => {
    const settings = normalizeForecastSettings();

    expect(eventImpactPct({ impact: 'high', impactPct: 62 }, settings.events)).toBe(62);
    expect(eventImpactPct({ impact: 'low' }, settings.events)).toBe(DEFAULT_FORECAST_SETTINGS.events.lowPct);
  });

  it('multiplies the active item factors into a final demand modifier', () => {
    const settings = normalizeForecastSettings({ payday: { pct: 10 } });
    const factors = buildItemFactors({
      category: 'coffee',
      signals: { ...baseSignals, isPayday: true },
      weather: { temp: 12, condition: 'Clear', isRain: false },
      events: [],
      settings,
    });

    expect(multiplyFactors(factors)).toBeCloseTo(1.15 * 1.10, 2);
  });
});
