import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  booleanField,
  errorMessage,
  formToObject,
  fractionToPercent,
  isPlaceholder,
  linesField,
  numberField,
  optionalNumberField,
  optionalTextField,
  percentField,
  percentToFraction,
  stripPlaceholder,
  uuidField,
} from './forms';

describe('percent <-> fraction', () => {
  it('converts without float noise', () => {
    expect(fractionToPercent(0.18)).toBe(18);
    expect(fractionToPercent(0.0999)).toBe(9.99);
    expect(fractionToPercent(0.07)).toBe(7);
    expect(percentToFraction(9.99)).toBe(0.0999);
    expect(percentToFraction(40)).toBe(0.4);
    expect(percentToFraction(0)).toBe(0);
  });

  it('round-trips typical values', () => {
    for (const f of [0, 0.01, 0.1, 0.15, 0.25, 0.333, 0.4, 0.6, 0.95, 1.5, 3]) {
      expect(percentToFraction(fractionToPercent(f))).toBe(f);
    }
  });
});

describe('formToObject', () => {
  it('keeps text entries and drops files', () => {
    const fd = new FormData();
    fd.set('a', '1');
    fd.set('b', 'x');
    fd.set('f', new Blob(['hi']), 'f.txt');
    expect(formToObject(fd)).toEqual({ a: '1', b: 'x' });
  });
});

describe('field builders', () => {
  it('numberField parses and bounds', () => {
    const f = numberField('Price', { min: 0, max: 100 });
    expect(f.parse('42')).toBe(42);
    expect(f.parse(' $1,0 ')).toBe(10);
    expect(f.safeParse('').error?.issues[0]?.message).toBe('Price is required');
    expect(f.safeParse('abc').error?.issues[0]?.message).toBe('Price must be a number');
    expect(f.safeParse('-1').error?.issues[0]?.message).toBe('Price must be at least 0');
    expect(f.safeParse('101').error?.issues[0]?.message).toBe('Price must be at most 100');
  });

  it('numberField integer, gt and lt', () => {
    expect(numberField('Days', { integer: true }).safeParse('1.5').success).toBe(false);
    expect(numberField('Hours', { gt: 0 }).safeParse('0').success).toBe(false);
    expect(numberField('Margin', { lt: 95 }).safeParse('95').success).toBe(false);
    expect(numberField('Margin', { lt: 95 }).parse('94.9')).toBe(94.9);
  });

  it('percentField returns a fraction', () => {
    expect(percentField('Overhead', { min: 0, max: 300 }).parse('18')).toBe(0.18);
    expect(percentField('Overhead', { min: 0, max: 300 }).parse('18%')).toBe(0.18);
    expect(percentField('Margin', { min: 0, max: 95 }).safeParse('96').success).toBe(false);
  });

  it('optionalNumberField maps blank to null', () => {
    const f = optionalNumberField('Target R', { gt: 0 });
    expect(f.parse('')).toBeNull();
    expect(f.parse(undefined)).toBeNull();
    expect(f.parse('49')).toBe(49);
    expect(f.safeParse('0').success).toBe(false);
    expect(f.safeParse('x').success).toBe(false);
  });

  it('optionalTextField trims and nulls', () => {
    const f = optionalTextField('Note', 5);
    expect(f.parse('  hi ')).toBe('hi');
    expect(f.parse('   ')).toBeNull();
    expect(f.safeParse('toolong').success).toBe(false);
  });

  it('booleanField', () => {
    expect(booleanField.parse('true')).toBe(true);
    expect(booleanField.parse('on')).toBe(true);
    expect(booleanField.parse('false')).toBe(false);
    expect(booleanField.parse(undefined)).toBe(false);
  });

  it('linesField splits lines and drops blanks', () => {
    expect(linesField('Bullets').parse('a\r\n\n  b  \n')).toEqual(['a', 'b']);
    expect(linesField('Bullets').parse(undefined)).toEqual([]);
    expect(linesField('Bullets', 1).safeParse('a\nb').success).toBe(false);
  });

  it('uuidField', () => {
    expect(uuidField('Crew').safeParse('8f14e45f-ceea-467f-a8f6-3b3a0c6c2b10').success).toBe(true);
    expect(uuidField('Crew').safeParse('nope').success).toBe(false);
  });
});

describe('errorMessage', () => {
  it('formats zod errors, Errors and other values', () => {
    const r = z.object({ a: z.number() }).safeParse({ a: 'x' });
    expect(errorMessage(r.error)).toMatch(/^a: /);
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('plain')).toBe('plain');
  });
});

describe('placeholder wording', () => {
  it('detects placeholders', () => {
    expect(isPlaceholder('Overhead — PLACEHOLDER')).toBe(true);
    expect(isPlaceholder('Workmanship warranty — placeholder')).toBe(true);
    expect(isPlaceholder('Round customer price')).toBe(false);
    expect(isPlaceholder(null)).toBe(false);
    expect(isPlaceholder(5)).toBe(false);
  });

  it('strips seed wording from descriptions', () => {
    expect(stripPlaceholder('Overhead as % of direct cost — PLACEHOLDER')).toBe('Overhead as % of direct cost');
    expect(stripPlaceholder('Minimum job price ($) — PLACEHOLDER')).toBe('Minimum job price ($)');
    expect(stripPlaceholder('Origin for drive-time lookups — PLACEHOLDER, set the shop address')).toBe('Origin for drive-time lookups');
    expect(stripPlaceholder('Terms printed on every quote — PLACEHOLDER, owner to replace')).toBe('Terms printed on every quote');
    expect(stripPlaceholder('PLACEHOLDER — confirm partner/terms', 'Financing')).toBe('Financing');
    expect(stripPlaceholder('PLACEHOLDER — PDF branding')).toBeNull();
    expect(stripPlaceholder('Some PLACEHOLDER text')).toBe('Some text');
    expect(stripPlaceholder('Round customer price to nearest $')).toBe('Round customer price to nearest $');
    expect(stripPlaceholder(null, 'x')).toBeNull();
  });
});
