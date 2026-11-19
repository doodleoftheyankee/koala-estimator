import { describe, expect, it } from 'vitest';
import { degreesSuggestion, formatFeet, MAX_RISE, parseFeet, parsePitch, readPitch } from './units';

describe('parseFeet', () => {
  it.each([
    [`24'6"`, 24.5], [`24' 6"`, 24.5], [`24'6`, 24.5], ['24.5', 24.5], [`294"`, 24.5], ['294in', 24.5],
    ['24 6', 24.5], [`24ft 6in`, 24.5], [`24’6”`, 24.5], [`24'`, 24], [`24'0"`, 24], [`6 1/2"`, 6.5 / 12],
    [`10'6 1/2"`, 10 + 6.5 / 12], ['.5', 0.5], [`24''`, 2], ['  30  ', 30],
  ])('%s → %f', (text, feet) => expect(parseFeet(text)).toBeCloseTo(feet, 9));

  it.each(['', 'abc', `24'13"`, '24 12', `1/0"`, '--', `24'6"5`])('rejects %j', (text) => expect(parseFeet(text)).toBeNull());
});

describe('parsePitch', () => {
  it('reads rise/12 forms', () => {
    expect(parsePitch('6/12')).toBe(6);
    expect(parsePitch('6')).toBe(6);
    expect(parsePitch('7.5:12')).toBe(7.5);
    expect(parsePitch('3/6')).toBe(6);
    expect(parsePitch('x')).toBeNull();
  });
});

describe('pitch in degrees and the 24/12 limit (L25, RF-06, S2-F13)', () => {
  it('reads a pitch typed in degrees as degrees', () => {
    expect(parsePitch('30 deg')).toBeCloseTo(12 * Math.tan(Math.PI / 6), 9);
    expect(parsePitch('30 deg')).toBeCloseTo(6.93, 2);
    expect(parsePitch('30°')).toBeCloseTo(6.928, 3);
    expect(parsePitch('45 degrees')).toBeCloseTo(12, 9);
    expect(parsePitch('26.6º')).toBeCloseTo(6.009, 3);
    expect(parsePitch('18.4 DEG')).toBeCloseTo(3.992, 3);
    expect(parsePitch('0°')).toBe(0);
    expect(readPitch('30 deg')).toEqual({ ok: true, rise: 12 * Math.tan(Math.PI / 6), degrees: 30 });
    expect(readPitch('6/12')).toEqual({ ok: true, rise: 6, degrees: null });
  });

  it('takes nothing steeper than 24/12', () => {
    expect(MAX_RISE).toBe(24);
    expect(parsePitch('24/12')).toBe(24);
    expect(parsePitch('12/6')).toBe(24);
    expect(parsePitch('24')).toBe(24);
    expect(parsePitch('30/12')).toBeNull();
    expect(parsePitch('13/6')).toBeNull();
    expect(parsePitch('30')).toBeNull();
    expect(parsePitch('100')).toBeNull();
    expect(parsePitch('70°')).toBeNull();
    expect(parsePitch('90 deg')).toBeNull();
    expect(parsePitch('63.4°')).toBeCloseTo(23.96, 2);
  });

  it('says why a pitch is refused, with a hint', () => {
    expect(readPitch('100')).toEqual({ ok: false, error: 'Pitch "100" would be 100/12, steeper than 24/12. Type the rise per 12, e.g. 6/12, or degrees, e.g. 30°.' });
    expect(readPitch('30')).toEqual({ ok: false, error: 'Pitch "30" would be 30/12, steeper than 24/12. For degrees, type 30°.' });
    expect(readPitch('30/12')).toEqual({ ok: false, error: 'Pitch "30/12" is steeper than 24/12. Check the numbers.' });
    expect(readPitch('70°')).toEqual({ ok: false, error: 'Pitch "70°" is steeper than 24/12 (63.4°). Check the angle.' });
    expect(readPitch('abc', 'Second pitch')).toEqual({ ok: false, error: 'Second pitch "abc" isn\'t valid. Type the rise per 12, e.g. 6/12, or degrees, e.g. 30°.' });
    expect(readPitch('  ')).toBeNull();
  });

  it('offers the degrees reading of a bare number that reads as a steep roof', () => {
    expect(degreesSuggestion('30')).toBe('30°');
    expect(degreesSuggestion('18')).toBe('18°');
    expect(degreesSuggestion('12.5')).toBe('12.5°');
    expect(degreesSuggestion('12')).toBeNull(); // 12/12 is an ordinary steep roof
    expect(degreesSuggestion('6')).toBeNull();
    expect(degreesSuggestion('100')).toBeNull(); // no roof is 100°
    expect(degreesSuggestion('70')).toBeNull(); // 70° is steeper than 24/12 too
    expect(degreesSuggestion('30/12')).toBeNull();
    expect(degreesSuggestion('30°')).toBeNull();
  });
});

describe('formatFeet', () => {
  it('rounds to inches', () => {
    expect(formatFeet(24.5)).toBe(`24' 6"`);
    expect(formatFeet(24)).toBe(`24'`);
    expect(formatFeet(0.5)).toBe(`6"`);
    expect(formatFeet(11.999)).toBe(`12'`);
  });
});
