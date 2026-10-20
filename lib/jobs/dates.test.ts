import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  addDays,
  dayLabel,
  daysBetween,
  formatNyDateTime,
  formatYmd,
  isYmd,
  nyDate,
  nyOffsetMinutes,
  nyStartOfDay,
  recentCutoffIso,
} from './dates';

describe('nyDate', () => {
  it('uses the New York calendar day, not UTC', () => {
    expect(nyDate('2026-10-21T03:30:00Z')).toBe('2026-10-20'); // 11:30 PM EDT
    expect(nyDate(new Date('2026-10-21T04:00:00Z'))).toBe('2026-10-21'); // midnight EDT
    expect(nyDate('2026-01-15T04:59:59Z')).toBe('2026-01-14'); // 11:59 PM EST
    expect(nyDate('2026-01-15T05:00:00Z')).toBe('2026-01-15');
  });
});

describe('nyOffsetMinutes', () => {
  it('is -240 in summer and -300 in winter', () => {
    expect(nyOffsetMinutes(new Date('2026-07-01T12:00:00Z'))).toBe(-240);
    expect(nyOffsetMinutes(new Date('2026-12-01T12:00:00Z'))).toBe(-300);
  });
});

describe('nyStartOfDay', () => {
  it('finds local midnight, including on DST switch days', () => {
    expect(nyStartOfDay('2026-10-20').toISOString()).toBe('2026-10-20T04:00:00.000Z');
    expect(nyStartOfDay('2026-01-15').toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(nyStartOfDay('2026-03-08').toISOString()).toBe('2026-03-08T05:00:00.000Z'); // spring forward at 2 AM
    expect(nyStartOfDay('2026-03-09').toISOString()).toBe('2026-03-09T04:00:00.000Z');
    expect(nyStartOfDay('2026-11-01').toISOString()).toBe('2026-11-01T04:00:00.000Z'); // fall back at 2 AM
    expect(nyStartOfDay('2026-11-02').toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });
  it('rejects malformed dates', () => {
    expect(() => nyStartOfDay('2026-02-30')).toThrow(RangeError);
    expect(() => nyStartOfDay('yesterday')).toThrow(RangeError);
  });
  it('brackets every instant: start(day(t)) <= t < start(day(t) + 1)', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2020-01-01T00:00:00Z'), max: new Date('2035-12-31T00:00:00Z'), noInvalidDate: true }), (t) => {
        const day = nyDate(t);
        expect(nyStartOfDay(day).getTime()).toBeLessThanOrEqual(t.getTime());
        expect(nyStartOfDay(addDays(day, 1)).getTime()).toBeGreaterThan(t.getTime());
        expect(nyDate(nyStartOfDay(day))).toBe(day);
      }),
      { numRuns: 300 },
    );
  });
});

describe('calendar arithmetic', () => {
  it('adds days across months and years', () => {
    expect(addDays('2026-10-20', -14)).toBe('2026-10-06');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-10-20', '2026-10-06')).toBe(-14);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2); // DST does not shorten a calendar day count
  });
  it('validates YYYY-MM-DD', () => {
    expect(isYmd('2026-02-28')).toBe(true);
    expect(isYmd('2026-02-29')).toBe(false);
    expect(isYmd('2026-2-28')).toBe(false);
    expect(isYmd('')).toBe(false);
  });
});

describe('recentCutoffIso', () => {
  it('is the start of the New York day N days ago', () => {
    expect(recentCutoffIso(new Date('2026-10-20T15:00:00Z'), 14)).toBe('2026-10-06T04:00:00.000Z');
    // 10 PM on Oct 20 in New York is already Oct 21 in UTC: still counts from Oct 20.
    expect(recentCutoffIso(new Date('2026-10-21T02:00:00Z'), 14)).toBe('2026-10-06T04:00:00.000Z');
    expect(recentCutoffIso(new Date('2026-11-10T15:00:00Z'), 14)).toBe('2026-10-27T04:00:00.000Z');
  });
});

describe('formatting', () => {
  it('formats a date column as the day it names', () => {
    expect(formatYmd('2026-10-20')).toBe('Tue, Oct 20');
    expect(formatYmd('2026-10-20', '2026-10-01')).toBe('Tue, Oct 20');
    expect(formatYmd('2027-01-06', '2026-12-30')).toBe('Wed, Jan 6, 2027');
  });
  it('names nearby days', () => {
    expect(dayLabel('2026-10-20', '2026-10-20')).toBe('Today');
    expect(dayLabel('2026-10-21', '2026-10-20')).toBe('Tomorrow');
    expect(dayLabel('2026-10-19', '2026-10-20')).toBe('Yesterday');
    expect(dayLabel('2026-10-23', '2026-10-20')).toBe('Fri, Oct 23');
  });
  it('shows malformed dates as they are instead of failing the page', () => {
    expect(formatYmd('2026-13-01')).toBe('2026-13-01');
    expect(dayLabel('soon', '2026-10-20')).toBe('soon');
    expect(dayLabel('2026-10-21', 'bad')).toBe('Wed, Oct 21');
  });
  it('shows instants in New York time', () => {
    expect(formatNyDateTime('2026-10-20T19:45:00Z')).toMatch(/^Oct 20, 3:45\sPM$/);
    expect(formatNyDateTime(new Date('2026-01-15T04:30:00Z'))).toMatch(/^Jan 14, 11:30\sPM$/);
  });
});
