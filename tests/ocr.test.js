import { describe, it, expect } from 'vitest';
import { parseMeterText, parseVoucherText } from '../src/services/ocr.js';

/**
 * The text-to-candidates step, tested without touching the network so it
 * costs no API quota and does not depend on OCR.space being up.
 *
 * The sample in the first test is the literal output OCR.space returned for a
 * meter photograph, so these are the real shapes, not invented ones.
 */
describe('parseMeterText', () => {
  it('pulls the registers and the date out of a real meter read', () => {
    const result = parseMeterText(
      [
        'SHANGRI-LA POWER',
        'ELECTRICITY METER',
        '004512.3',
        'DAY',
        '004512',
        'NIGHT',
        '008976',
        'READ 13/11/2026',
        'kWh',
      ].join('\n'),
    );
    expect(result.readings).toEqual([4512.3, 4512, 8976]);
    expect(result.date).toBe('2026-11-13');
  });

  it('reads the date day-first, as a UK meter prints it', () => {
    // 11/12 is 11 December, not 12 November.
    expect(parseMeterText('11/12/2026').date).toBe('2026-12-11');
  });

  it('accepts a year-first date too', () => {
    expect(parseMeterText('2026-03-07 004512').date).toBe('2026-03-07');
  });

  it('expands a two-digit year', () => {
    expect(parseMeterText('13/11/26').date).toBe('2026-11-13');
  });

  it('does not read the date as three meter readings', () => {
    const { readings } = parseMeterText('13/11/2026 004512');
    expect(readings).toEqual([4512]);
    expect(readings).not.toContain(2026);
  });

  it('rejects an impossible date rather than rolling it over', () => {
    // Date() would turn 31 February into 3 March if left alone.
    expect(parseMeterText('31/02/2026').date).toBeNull();
  });

  it('corrects the characters OCR confuses on a display', () => {
    // O -> 0, l/I -> 1, S -> 5
    expect(parseMeterText('OO45l2').readings).toEqual([4512]);
    expect(parseMeterText('S0O76').readings).toEqual([50076]);
  });

  it('ignores runs too short to be a meter register', () => {
    const { readings } = parseMeterText('kWh 12 m3 7 004512');
    expect(readings).toEqual([4512]);
  });

  it('keeps one decimal place where the meter shows one', () => {
    expect(parseMeterText('004512,3').readings).toEqual([4512.3]);
  });

  it('returns empty results for text with nothing numeric in it', () => {
    const result = parseMeterText('ELECTRICITY METER SHANGRI-LA POWER');
    expect(result.readings).toEqual([]);
    expect(result.date).toBeNull();
  });

  it('survives empty and missing input', () => {
    expect(parseMeterText('').readings).toEqual([]);
    expect(parseMeterText(undefined).date).toBeNull();
    expect(parseMeterText(null).text).toBe('');
  });
});

describe('parseMeterText — suggesting the register', () => {
  it('prefers the longest run of digits over other numbers on the meter', () => {
    // Taken from a real gas meter: "2007" is stamped on the casing, the
    // register reads 002500. Picking the first number found would be wrong.
    const result = parseMeterText('GAS 1\n2007\n002500 m\nESOJNE778055015');
    expect(result.readings).toContain(2500);
    expect(result.suggested).toBe(2500);
  });

  it('suggests the only candidate when there is just one', () => {
    expect(parseMeterText('000300\nDAYTIME\nKWh').suggested).toBe(300);
  });

  it('keeps document order in the candidate list', () => {
    expect(parseMeterText('2007 002500').readings).toEqual([2007, 2500]);
  });

  it('suggests nothing when nothing was read', () => {
    expect(parseMeterText('DAYTIME kWh').suggested).toBeNull();
  });
});

describe('parseVoucherText', () => {
  it('finds a voucher code in surrounding text', () => {
    const r = parseVoucherText('SHANGRI-LA POWER\nESSV VOUCHER\nJOV50TOSYR\nValue £50');
    expect(r.codes).toContain('JOV50TOSYR');
    expect(r.suggested).toBe('JOV50TOSYR');
  });

  it('joins a code printed in spaced groups', () => {
    // Vouchers are commonly printed "JOV50 TOSYR" or with hyphens.
    expect(parseVoucherText('JOV50 TOSYR').suggested).toBe('JOV50TOSYR');
    expect(parseVoucherText('JOV50-TOSYR').suggested).toBe('JOV50TOSYR');
  });

  it('upper-cases what the scan returned in lower case', () => {
    expect(parseVoucherText('jov50tosyr').suggested).toBe('JOV50TOSYR');
  });

  it('does not offer a run that is too short', () => {
    expect(parseVoucherText('ESSV 2026 VOUCHER').codes).toEqual([]);
    expect(parseVoucherText('ABC123').suggested).toBeNull();
  });

  it('keeps distinct candidates in the order they were read', () => {
    const r = parseVoucherText('1AZN0FXJVM then E4GE75H7Q6');
    expect(r.codes).toEqual(['1AZN0FXJVM', 'E4GE75H7Q6']);
  });

  it('survives empty input', () => {
    expect(parseVoucherText('').codes).toEqual([]);
    expect(parseVoucherText(undefined).suggested).toBeNull();
  });
});
