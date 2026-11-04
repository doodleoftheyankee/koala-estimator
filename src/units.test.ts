import { describe, expect, it } from 'vitest';
import { formatFeet, parseFeet, parsePitch } from './units';

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

describe('formatFeet', () => {
  it('rounds to inches', () => {
    expect(formatFeet(24.5)).toBe(`24' 6"`);
    expect(formatFeet(24)).toBe(`24'`);
    expect(formatFeet(0.5)).toBe(`6"`);
    expect(formatFeet(11.999)).toBe(`12'`);
  });
});
