import { describe, expect, it } from 'vitest';
import {
  BUSINESS_TIME_ZONE,
  DASH,
  businessDate,
  feet,
  formatDate,
  formatDateLong,
  formatDateTime,
  formatDayMonth,
  formatShortDateTime,
  formatTime,
  inches,
  isWholeDollars,
  formatMoney,
  formatPhone,
  num,
  pct,
  percent,
  personHours,
  pitch,
  plural,
  relativeTime,
  rValue,
  sqft,
  timeAgo,
  usd,
} from './format';

describe('format', () => {
  it('formats money, percent and numbers', () => {
    expect(usd(5420)).toBe('$5,420');
    expect(usd(5420.5, true)).toBe('$5,420.50');
    expect(pct(0.4005)).toBe('40.1%');
    expect(num(1234.567, 1)).toBe('1,234.6');
  });
  it('describes elapsed time', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(timeAgo('2026-10-20T11:59:30Z', now)).toBe('just now');
    expect(timeAgo('2026-10-20T11:45:00Z', now)).toBe('15 min ago');
    expect(timeAgo('2026-10-20T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-19T09:00:00Z', now)).toBe('yesterday');
    expect(timeAgo('2026-10-15T09:00:00Z', now)).toBe('5 days ago');
  });
});

describe('formatMoney', () => {
  it('shows whole dollars when the amount is whole, cents otherwise', () => {
    expect(formatMoney(4780)).toBe('$4,780');
    expect(formatMoney(4321.5)).toBe('$4,321.50');
    expect(formatMoney(4321.05)).toBe('$4,321.05');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(-1430)).toBe('-$1,430');
  });
  it('never shows a single decimal ("$4,321.5")', () => {
    for (const n of [0.1, 1.5, 4321.5, 99.9, 1234567.4]) expect(formatMoney(n)).toMatch(/^-?\$[\d,]+(\.\d{2})?$/);
  });
  it('treats float noise as whole dollars at cent precision', () => {
    expect(isWholeDollars(4780.0000001)).toBe(true);
    expect(formatMoney(0.1 + 0.2 - 0.3 + 4780)).toBe('$4,780');
    expect(isWholeDollars(4780.01)).toBe(false);
  });
  it('can always or never show cents, and show a sign', () => {
    expect(formatMoney(4780, { cents: 'always' })).toBe('$4,780.00');
    expect(formatMoney(4780.6, { cents: 'never' })).toBe('$4,781');
    expect(formatMoney(4780.6, { cents: 'never' })).toBe(usd(4780.6));
    expect(formatMoney(1430, { sign: true })).toBe('+$1,430');
    expect(formatMoney(-12.5, { sign: true })).toBe('-$12.50');
    expect(formatMoney(0, { sign: true })).toBe('$0');
  });
  it('reads an overridden price with cents the same in the field dock, the list and the Options card (RC-4)', () => {
    // The dock and the field list use formatMoney(n, { cents: 'never' }); Options, Send and the
    // quote's option cards use usd(n). Same value, same words.
    for (const n of [4321.5, 4321.49, 4095, 1999.99]) expect(formatMoney(n, { cents: 'never' })).toBe(usd(n));
    expect(formatMoney(4321.5, { cents: 'never' })).toBe('$4,322');
  });
  it('shows a dash for a missing amount', () => {
    expect(formatMoney(null)).toBe(DASH);
    expect(formatMoney(undefined)).toBe(DASH);
    expect(formatMoney(Number.NaN)).toBe(DASH);
  });
  it('does not change the value it shows', () => {
    for (const n of [1, 12.34, 999.99, 4780, 100000.5]) {
      expect(Number(formatMoney(n).replace(/[$,]/g, ''))).toBeCloseTo(n, 2);
    }
  });
});

describe('numbers and units', () => {
  it('formats percents with an optional sign', () => {
    expect(percent(0.12, { digits: 0, sign: true })).toBe('+12%');
    expect(percent(-0.213)).toBe('-21.3%');
    expect(percent(0, { sign: true })).toBe('0.0%');
    expect(percent(null)).toBe(DASH);
  });
  it('pluralises with the count', () => {
    expect(plural(1, 'face')).toBe('1 face');
    expect(plural(3, 'face')).toBe('3 faces');
    expect(plural(1200, 'bundle')).toBe('1,200 bundles');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
  it('writes units one way', () => {
    expect(sqft(1970)).toBe('1,970 sq ft');
    expect(sqft(1969.6)).toBe('1,970 sq ft');
    expect(sqft(12.25, 1)).toBe('12.3 sq ft');
    expect(feet(204)).toBe('204 ft');
    expect(inches(12)).toBe('12 in');
    expect(inches(3.5)).toBe('3.5 in');
    expect(rValue(60)).toBe('R-60');
    expect(rValue(13.5)).toBe('R-13.5');
    expect(pitch(6)).toBe('6/12');
    expect(pitch(6.5)).toBe('6.5/12');
    expect(pitch(1.25)).toBe('1.25/12');
    expect(personHours(12.5)).toBe('12.5 person-hours');
    expect(personHours(1)).toBe('1 person-hour');
    expect(personHours(12.5, { short: true })).toBe('12.5 p-h');
    expect(sqft(null)).toBe(DASH);
    expect(pitch(undefined)).toBe(DASH);
  });
});

describe('formatPhone', () => {
  it('reads North American numbers the same way however they were stored', () => {
    expect(formatPhone('+13025550007')).toBe('(302) 555-0007');
    expect(formatPhone('302.555.0007')).toBe('(302) 555-0007');
    expect(formatPhone('1-302-555-0007')).toBe('(302) 555-0007');
    expect(formatPhone('(555) 010-0142')).toBe('(555) 010-0142');
  });
  it('leaves anything else as typed, and dashes a missing number', () => {
    expect(formatPhone('302-555-0100 ext 12')).toBe('302-555-0100 ext 12');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone('555-0100')).toBe('555-0100');
    expect(formatPhone('  ')).toBe(DASH);
    expect(formatPhone(null)).toBe(DASH);
  });
});

describe('dates and times', () => {
  // 00:41 UTC on Nov 18 is 7:41 PM on Nov 17 in New York (EST, UTC-5).
  const sent = '2026-11-18T00:41:05Z';
  it('uses the one business time zone', () => {
    expect(BUSINESS_TIME_ZONE).toBe('America/New_York');
    expect(businessDate(sent)).toBe('2026-11-17');
    // Summer: EDT, UTC-4.
    expect(businessDate('2026-07-01T03:30:00Z')).toBe('2026-06-30');
  });
  it('formats dates and times one way', () => {
    expect(formatDate(sent)).toBe('Nov 17, 2026');
    expect(formatDateLong(sent)).toBe('November 17, 2026');
    expect(formatDayMonth(sent)).toBe('Nov 17');
    expect(formatTime(sent)).toBe('7:41 PM');
    expect(formatDateTime(sent)).toBe('Nov 17, 2026 · 7:41 PM');
    expect(formatShortDateTime(sent)).toBe('Nov 17 · 7:41 PM');
    expect(formatDateTime(new Date(sent))).toBe('Nov 17, 2026 · 7:41 PM');
    expect(formatDate(Date.parse(sent))).toBe('Nov 17, 2026');
  });
  it('shows a dash for missing or invalid dates', () => {
    for (const bad of [null, undefined, '', 'not a date']) {
      expect(formatDate(bad)).toBe(DASH);
      expect(formatDateTime(bad)).toBe(DASH);
      expect(relativeTime(bad)).toBe(DASH);
    }
    expect(businessDate('nope')).toBeNull();
  });
  it('gives relative time for lists', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(relativeTime('2026-10-20T11:58:00Z', now)).toBe('2 min ago');
    expect(relativeTime(new Date('2026-10-20T12:00:30Z'), now)).toBe('just now');
  });
});
