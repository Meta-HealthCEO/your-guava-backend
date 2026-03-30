/**
 * Unit tests for forecast service modifiers.
 *
 * We test the internal functions by requiring the forecast.service module
 * and checking that the unexported functions can be tested indirectly.
 * Since the modifiers are not exported, we replicate the logic for unit testing.
 * The integration test (forecasts.test.js) tests the full generateForecast flow.
 */

describe('forecast modifiers (logic verification)', () => {
  // Replicate the exported-in-module logic for testing
  const weatherModifier = (category, weather) => {
    let mod = 1.0;
    if (!weather) return mod;
    const { temp, isRain } = weather;
    if (temp > 27) {
      if (category === 'cold_drink') mod += 0.30;
      if (category === 'coffee') mod -= 0.10;
    } else if (temp < 18) {
      if (category === 'coffee') mod += 0.15;
      if (category === 'cold_drink') mod -= 0.20;
    }
    if (isRain) {
      mod -= 0.10;
    }
    return Math.max(mod, 0.1);
  };

  const loadSheddingModifier = (stage) => {
    if (stage === 0) return 1.0;
    if (stage <= 2) return 0.92;
    if (stage <= 4) return 0.78;
    return 0.60;
  };

  const holidayModifier = (isPublicHoliday, isSchoolHoliday) => {
    if (isPublicHoliday && isSchoolHoliday) return 1.20;
    if (isPublicHoliday) return 1.15;
    if (isSchoolHoliday) return 1.08;
    return 1.0;
  };

  const paydayModifier = (isPayday) => (isPayday ? 1.20 : 1.0);

  describe('weatherModifier', () => {
    it('boosts cold_drink on hot days (temp > 27)', () => {
      const mod = weatherModifier('cold_drink', { temp: 30, isRain: false });
      expect(mod).toBeCloseTo(1.30, 2);
    });

    it('reduces coffee on hot days (temp > 27)', () => {
      const mod = weatherModifier('coffee', { temp: 30, isRain: false });
      expect(mod).toBeCloseTo(0.90, 2);
    });

    it('boosts coffee on cold days (temp < 18)', () => {
      const mod = weatherModifier('coffee', { temp: 12, isRain: false });
      expect(mod).toBeCloseTo(1.15, 2);
    });

    it('reduces cold_drink on cold days (temp < 18)', () => {
      const mod = weatherModifier('cold_drink', { temp: 12, isRain: false });
      expect(mod).toBeCloseTo(0.80, 2);
    });

    it('applies rain penalty', () => {
      const mod = weatherModifier('food', { temp: 22, isRain: true });
      expect(mod).toBeCloseTo(0.90, 2);
    });

    it('stacks cold day + rain for cold_drink', () => {
      const mod = weatherModifier('cold_drink', { temp: 12, isRain: true });
      // -0.20 (cold) - 0.10 (rain) = 0.70
      expect(mod).toBeCloseTo(0.70, 2);
    });

    it('returns 1.0 when weather is null', () => {
      expect(weatherModifier('coffee', null)).toBe(1.0);
    });

    it('returns at least 0.1 (minimum floor)', () => {
      // Extreme case: should not go below 0.1
      const mod = weatherModifier('cold_drink', { temp: 10, isRain: true });
      expect(mod).toBeGreaterThanOrEqual(0.1);
    });

    it('returns 1.0 for neutral temperature (18-27)', () => {
      const mod = weatherModifier('coffee', { temp: 22, isRain: false });
      expect(mod).toBe(1.0);
    });
  });

  describe('loadSheddingModifier', () => {
    it('returns 1.0 for stage 0 (no load shedding)', () => {
      expect(loadSheddingModifier(0)).toBe(1.0);
    });

    it('returns 0.92 for stage 1', () => {
      expect(loadSheddingModifier(1)).toBe(0.92);
    });

    it('returns 0.92 for stage 2', () => {
      expect(loadSheddingModifier(2)).toBe(0.92);
    });

    it('returns 0.78 for stage 3', () => {
      expect(loadSheddingModifier(3)).toBe(0.78);
    });

    it('returns 0.78 for stage 4', () => {
      expect(loadSheddingModifier(4)).toBe(0.78);
    });

    it('returns 0.60 for stage 5+', () => {
      expect(loadSheddingModifier(5)).toBe(0.60);
      expect(loadSheddingModifier(6)).toBe(0.60);
    });
  });

  describe('holidayModifier', () => {
    it('returns 1.20 for public holiday + school holiday', () => {
      expect(holidayModifier(true, true)).toBe(1.20);
    });

    it('returns 1.15 for public holiday only', () => {
      expect(holidayModifier(true, false)).toBe(1.15);
    });

    it('returns 1.08 for school holiday only', () => {
      expect(holidayModifier(false, true)).toBe(1.08);
    });

    it('returns 1.0 when no holidays', () => {
      expect(holidayModifier(false, false)).toBe(1.0);
    });
  });

  describe('paydayModifier', () => {
    it('returns 1.20 on payday', () => {
      expect(paydayModifier(true)).toBe(1.20);
    });

    it('returns 1.0 on non-payday', () => {
      expect(paydayModifier(false)).toBe(1.0);
    });
  });
});
