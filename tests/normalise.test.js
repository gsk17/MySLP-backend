import { describe, it, expect } from 'vitest';
import {
  normaliseAddress,
  normalisePostcode,
  normaliseEmail,
  normaliseVoucherCode,
} from '../src/utils/normalise.js';
describe('normalisation — the REST API matching rules', () => {
  it('matches postcodes regardless of spaces and case', () => {
    const target = normalisePostcode('LE1 7RH');
    expect(normalisePostcode('LE17RH')).toBe(target);
    expect(normalisePostcode('le1 7rh')).toBe(target);
    expect(normalisePostcode('LE1  7RH')).toBe(target);
    expect(normalisePostcode('le1-7rh')).toBe(target);
  });
  it('matches addresses regardless of punctuation, case and spacing', () => {
    const target = normaliseAddress('20 University Road, Shangri-La');
    expect(normaliseAddress('20 university road shangri la')).toBe(target);
    expect(normaliseAddress('20 University Road,  Shangri-La')).toBe(target);
    expect(normaliseAddress('20 UNIVERSITY ROAD, SHANGRI-LA')).toBe(target);
  });
  it('lowercases and trims emails', () => {
    expect(normaliseEmail('  Alice@Example.COM ')).toBe('alice@example.com');
  });
  it('uppercases voucher codes and strips whitespace', () => {
    expect(normaliseVoucherCode(' jov50 tosyr ')).toBe('JOV50TOSYR');
  });
});
