import { describe, it, expect } from 'vitest';
import { calculateBill, validateAgainstPrevious } from '../src/services/billing.js';
import { ApiError } from '../src/utils/errors.js';
import { dayCount, toUtcDate, round2, formatStatNumber } from '../src/utils/normalise.js';

/** The example tariff from coursework Appendix 3. */
const TARIFF = {
  electricityDayRate: 0.34,
  electricityNightRate: 0.2,
  gasRate: 0.1,
  standingChargePerDay: 0,
};
const baseline = {
  readingDate: toUtcDate('2026-09-20'),
  electricityDay: 100,
  electricityNight: 250,
  gas: 800,
};
const october = {
  readingDate: toUtcDate('2026-10-20'),
  electricityDay: 200,
  electricityNight: 500,
  gas: 1600,
};
const november = {
  readingDate: toUtcDate('2026-11-20'),
  electricityDay: 300,
  electricityNight: 800,
  gas: 2500,
};
describe('billing — coursework Appendix 3 worked example', () => {
  it('first bill: 30 days from 2026-09-20 totals 164.00', () => {
    const bill = calculateBill(baseline, october, TARIFF);
    expect(bill.days).toBe(30);
    expect(bill.dayKwh).toBe(100);
    expect(bill.nightKwh).toBe(250);
    expect(bill.gasKwh).toBe(800);

    // (200-100)*0.34 + (500-250)*0.20 + (1600-800)*0.10 = 34 + 50 + 80 = 164
    expect(bill.dayCost).toBe(34);
    expect(bill.nightCost).toBe(50);
    expect(bill.gasCost).toBe(80);
    expect(bill.standingCost).toBe(0);
    expect(bill.totalAmount).toBe(164);
  });
  it('second bill: 31 days from 2026-10-20 totals 184.00', () => {
    const bill = calculateBill(october, november, TARIFF);
    expect(bill.days).toBe(31);

    // (300-200)*0.34 + (800-500)*0.20 + (2500-1600)*0.10 = 34 + 60 + 90 = 184
    expect(bill.dayCost).toBe(34);
    expect(bill.nightCost).toBe(60);
    expect(bill.gasCost).toBe(90);
    expect(bill.totalAmount).toBe(184);
  });
  it('applies a non-zero standing charge as days x rate', () => {
    const bill = calculateBill(baseline, october, {
      ...TARIFF,
      standingChargePerDay: 0.5,
    });
    expect(bill.standingCost).toBe(15); // 30 days x 0.50
    expect(bill.totalAmount).toBe(179); // 164 + 15
  });
  it('charges the standing charge even when no energy was used', () => {
    const noUsage = {
      ...october,
      electricityDay: 100,
      electricityNight: 250,
      gas: 800,
    };
    const bill = calculateBill(baseline, noUsage, {
      ...TARIFF,
      standingChargePerDay: 0.25,
    });
    expect(bill.dayKwh).toBe(0);
    expect(bill.totalAmount).toBe(7.5); // 30 x 0.25
  });
  it('rounds money to 2 decimals without floating point drift', () => {
    const bill = calculateBill(
      {
        ...baseline,
        electricityDay: 0,
        electricityNight: 0,
        gas: 0,
      },
      {
        ...october,
        electricityDay: 3,
        electricityNight: 3,
        gas: 3,
      },
      {
        ...TARIFF,
        electricityDayRate: 0.1,
        electricityNightRate: 0.2,
        gasRate: 0.1,
      },
    );
    expect(bill.dayCost).toBe(0.3);
    expect(bill.totalAmount).toBe(1.2);
  });
});
describe('billing — reading validation', () => {
  it('rejects a reading lower than the previous one, naming the register', () => {
    const lower = {
      ...october,
      electricityNight: 480,
    };
    expect(() =>
      validateAgainstPrevious(
        {
          ...baseline,
          electricityNight: 500,
        },
        lower,
      ),
    ).toThrow(ApiError);
    try {
      validateAgainstPrevious(
        {
          ...baseline,
          electricityNight: 500,
        },
        lower,
      );
    } catch (err) {
      const apiError = err;
      expect(apiError.code).toBe('READING_LOWER_THAN_PREVIOUS');
      expect(apiError.field).toBe('electricityNight');
      expect(apiError.message).toContain('480 kWh');
      expect(apiError.message).toContain('500 kWh');
      expect(apiError.message).toContain('2026-09-20');
    }
  });
  it('rejects a lower daytime electricity reading', () => {
    expect(() =>
      validateAgainstPrevious(baseline, {
        ...october,
        electricityDay: 99,
      }),
    ).toThrowError(/Daytime electricity/);
  });
  it('rejects a lower gas reading', () => {
    expect(() =>
      validateAgainstPrevious(baseline, {
        ...october,
        gas: 799,
      }),
    ).toThrowError(/Gas reading/);
  });
  it('accepts an unchanged reading (zero usage is valid)', () => {
    expect(() =>
      validateAgainstPrevious(baseline, {
        ...october,
        electricityDay: 100,
        electricityNight: 250,
        gas: 800,
      }),
    ).not.toThrow();
  });
  it('rejects a date that is not after the previous reading', () => {
    expect(() =>
      validateAgainstPrevious(baseline, {
        ...october,
        readingDate: toUtcDate('2026-09-20'),
      }),
    ).toThrowError(/must be after your previous reading/);
  });
});
describe('utils', () => {
  it('counts days up to but excluding the latest date', () => {
    expect(dayCount(toUtcDate('2026-09-20'), toUtcDate('2026-10-20'))).toBe(30);
    expect(dayCount(toUtcDate('2026-10-20'), toUtcDate('2026-11-20'))).toBe(31);
    expect(dayCount(toUtcDate('2026-01-01'), toUtcDate('2026-01-02'))).toBe(1);
    expect(dayCount(toUtcDate('2026-01-01'), toUtcDate('2026-01-01'))).toBe(0);
  });
  it('is unaffected by daylight saving transitions', () => {
    // UK clocks go back on 2026-10-25.
    expect(dayCount(toUtcDate('2026-10-20'), toUtcDate('2026-10-30'))).toBe(10);
  });
  it('formats REST statistics without trailing zeros', () => {
    expect(formatStatNumber(9)).toBe('9');
    expect(formatStatNumber(9.0)).toBe('9');
    expect(formatStatNumber(9.456)).toBe('9.46');
    expect(formatStatNumber(0)).toBe('0');
    expect(formatStatNumber(Number.NaN)).toBe('0');
  });
  it('rounds to 2 decimals', () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(164.005)).toBe(164.01);
  });
});
