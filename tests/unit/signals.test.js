const { isPayday, isPublicHoliday, isSchoolHoliday } = require('../../src/utils/signals');

describe('signals utility', () => {
  describe('isPayday', () => {
    it('returns true for the 1st of the month', () => {
      expect(isPayday(new Date(2026, 0, 1))).toBe(true); // Jan 1
      expect(isPayday(new Date(2026, 5, 1))).toBe(true); // Jun 1
    });

    it('returns true for the 25th of the month', () => {
      expect(isPayday(new Date(2026, 0, 25))).toBe(true); // Jan 25
      expect(isPayday(new Date(2026, 7, 25))).toBe(true); // Aug 25
    });

    it('returns true for the last business day of the month', () => {
      // January 2026: 31st is Saturday, so last biz day = Friday 30th
      expect(isPayday(new Date(2026, 0, 30))).toBe(true);
      // February 2026: 28th is Saturday, so last biz day = Friday 27th
      expect(isPayday(new Date(2026, 1, 27))).toBe(true);
    });

    it('returns false for non-payday dates', () => {
      expect(isPayday(new Date(2026, 0, 15))).toBe(false); // Jan 15
      expect(isPayday(new Date(2026, 2, 10))).toBe(false); // Mar 10
      expect(isPayday(new Date(2026, 5, 18))).toBe(false); // Jun 18
    });
  });

  describe('isPublicHoliday', () => {
    it('returns true for New Year\'s Day (Jan 1)', () => {
      expect(isPublicHoliday(new Date(2026, 0, 1))).toBe(true);
    });

    it('returns true for Christmas Day (Dec 25)', () => {
      expect(isPublicHoliday(new Date(2026, 11, 25))).toBe(true);
    });

    it('returns true for Freedom Day (Apr 27)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 27))).toBe(true);
    });

    it('returns true for Human Rights Day (Mar 21)', () => {
      expect(isPublicHoliday(new Date(2026, 2, 21))).toBe(true);
    });

    it('returns true for 2026 Good Friday (Apr 3)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 3))).toBe(true);
    });

    it('returns true for 2026 Family Day / Easter Monday (Apr 6)', () => {
      expect(isPublicHoliday(new Date(2026, 3, 6))).toBe(true);
    });

    it('returns false for non-holiday dates', () => {
      expect(isPublicHoliday(new Date(2026, 0, 15))).toBe(false); // Jan 15
      expect(isPublicHoliday(new Date(2026, 6, 4))).toBe(false);  // Jul 4
      expect(isPublicHoliday(new Date(2026, 10, 15))).toBe(false); // Nov 15
    });
  });

  describe('isSchoolHoliday', () => {
    it('returns false during school term (in session)', () => {
      // 2026 Term 1: Jan 14 - Mar 27
      expect(isSchoolHoliday(new Date(2026, 0, 20))).toBe(false); // Jan 20
      expect(isSchoolHoliday(new Date(2026, 1, 15))).toBe(false); // Feb 15
      // 2026 Term 2: Apr 14 - Jun 26
      expect(isSchoolHoliday(new Date(2026, 4, 10))).toBe(false); // May 10
    });

    it('returns true during school holiday (outside term)', () => {
      // Between Term 1 and Term 2: Mar 28 - Apr 13
      expect(isSchoolHoliday(new Date(2026, 3, 1))).toBe(true); // Apr 1
      // After Term 4: Dec 12+
      expect(isSchoolHoliday(new Date(2026, 11, 20))).toBe(true); // Dec 20
      // Before Term 1: Jan 1-13
      expect(isSchoolHoliday(new Date(2026, 0, 5))).toBe(true); // Jan 5
    });
  });
});
