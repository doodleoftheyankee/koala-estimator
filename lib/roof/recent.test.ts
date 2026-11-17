import { describe, expect, it } from 'vitest';
import { recentLookups, RECENT_LIMIT, type RecentRow } from './recent';
import { SQFT_PER_M2 } from './lookup';

const ME = 'u-me';
const row = (id: string, minutesAgo: number, extra: Partial<RecentRow> = {}): RecentRow => ({
  id,
  created_at: new Date(Date.UTC(2026, 10, 17, 12, 0) - minutesAgo * 60_000).toISOString(),
  created_by: ME,
  address: '12 Elkton Rd, Newark, DE 19711',
  pin_lat: null,
  pin_lng: null,
  matched: '12 Elkton Rd, Newark, DE 19711, USA',
  roof: 237.5,
  floor: 182.7,
  segments: [
    { rise: 6, groundM2: 74.3 },
    { rise: 6, groundM2: 74.3 },
    { rise: 4, groundM2: 26.8 },
  ],
  ...extra,
});

describe('recentLookups', () => {
  it('maps a row to the address Google matched and the headline numbers', () => {
    expect(recentLookups([row('a', 5)], ME)).toEqual([
      { id: 'a', lookedUpAt: '2026-11-17T11:55:00.000Z', label: '12 Elkton Rd, Newark, DE 19711, USA', by: null, atticFloorSqft: 182.7 * SQFT_PER_M2, roofSqft: 237.5 * SQFT_PER_M2, mainPitch: 6 },
    ]);
  });

  it('lists each house once (its newest lookup), newest first', () => {
    const rows = [
      row('old', 60),
      row('typed-differently', 30, { address: '12 elkton rd newark de', matched: '12 Elkton Rd, Newark, DE 19711, USA' }),
      row('other', 45, { address: '3 Cross Gable Ct', matched: '3 Cross Gable Ct, Newark, DE 19711, USA' }),
      row('newest', 1),
    ];
    expect(recentLookups(rows, ME).map((r) => r.id)).toEqual(['newest', 'other']);
  });

  it('a tapped roof has no address: it is listed by its spot', () => {
    const pins = [
      row('pin', 2, { address: null, matched: null, pin_lat: 39.68347, pin_lng: -75.75039 }),
      row('same pin', 3, { address: null, matched: null, pin_lat: 39.683471, pin_lng: -75.750391 }),
      row('other pin', 4, { address: null, matched: null, pin_lat: 39.6835, pin_lng: -75.7504 }),
    ];
    const out = recentLookups(pins, ME);
    expect(out.map((r) => r.id)).toEqual(['pin', 'other pin']);
    expect(out[0]!.label).toBe('Roof tapped on the photo');
  });

  it("names who looked it up when it was someone else (the owner's list)", () => {
    const out = recentLookups([row('a', 1, { created_by: 'u-pat' }), row('b', 2, { created_by: 'u-gone', matched: '9 Carport Ct, Newark, DE 19711, USA' })], ME, { 'u-pat': 'Pat Lee' });
    expect(out.map((r) => r.by)).toEqual(['Pat Lee', 'Someone else']);
  });

  it('keeps going when a number is missing or broken', () => {
    const [r] = recentLookups([row('a', 1, { roof: null, floor: '182', segments: 'none', matched: 42 })], ME);
    expect(r).toMatchObject({ label: '12 Elkton Rd, Newark, DE 19711', atticFloorSqft: null, roofSqft: null, mainPitch: null });
    expect(recentLookups([row('a', 1, { segments: [{ rise: 'six' }, null, { rise: 8, groundM2: 10 }] })], ME)[0]!.mainPitch).toBe(8);
  });

  it(`shows at most ${RECENT_LIMIT}`, () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`, i, { matched: `${i + 1} Elkton Rd, Newark, DE 19711, USA` }));
    const out = recentLookups(rows, ME);
    expect(out).toHaveLength(RECENT_LIMIT);
    expect(out[0]!.id).toBe('r0');
    expect(recentLookups(rows, ME, {}, 3)).toHaveLength(3);
  });
});
