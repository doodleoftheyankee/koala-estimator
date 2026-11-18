import { describe, expect, it } from 'vitest';
import { nearestHouse, NEAR_M, recentLookups, RECENT_LIMIT, type RecentRow } from './recent';
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
      { id: 'a', lookedUpAt: '2026-11-17T11:55:00.000Z', label: '12 Elkton Rd, Newark, DE 19711, USA', tapped: false, by: null, atticFloorSqft: 182.7 * SQFT_PER_M2, roofSqft: 237.5 * SQFT_PER_M2, mainPitch: 6 },
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
    expect(out[0]).toMatchObject({ label: 'Roof tapped at 39.68347, -75.75039', tapped: true });
    expect(out[1]!.label).toBe('Roof tapped at 39.68350, -75.75040');
  });

  it('a tapped roof near a house looked up by its address is titled by that house', () => {
    const elkton = { lat: 39.6833743, lng: -75.7503689 };
    const rows = [
      row('pin', 1, { address: null, matched: null, pin_lat: 39.68347, pin_lng: -75.75039, point: { lat: 39.68347, lng: -75.75039 } }),
      row('house', 5, { point: elkton }),
      row('far pin', 6, { address: null, matched: null, pin_lat: 39.6829, pin_lng: -75.7509, point: { lat: 39.6829, lng: -75.7509 } }),
      row('typed only', 7, { address: '3 Cross Gable Ct', matched: null, point: { lat: 39.681482, lng: -75.7499942 } }),
      row('pin by the typed one', 8, { address: null, matched: null, pin_lat: 39.68152, pin_lng: -75.75002 }),
    ];
    expect(recentLookups(rows, ME).map((r) => [r.id, r.label, r.tapped])).toEqual([
      ['pin', 'Roof tapped near 12 Elkton Rd, Newark, DE 19711, USA', true],
      ['house', '12 Elkton Rd, Newark, DE 19711, USA', false],
      // About 70 m away: too far to say which house it is near.
      ['far pin', 'Roof tapped at 39.68290, -75.75090', true],
      ['typed only', '3 Cross Gable Ct', false],
      ['pin by the typed one', 'Roof tapped near 3 Cross Gable Ct', true],
    ]);
    // The nearest of two; nothing for a spot with no house near, or for rows without a place.
    const neighbour = row('b', 2, { matched: '14 Elkton Rd, Newark, DE 19711, USA', point: { lat: 39.68348, lng: -75.7504 } });
    expect(nearestHouse([row('a', 1, { point: elkton }), neighbour], { lat: 39.68347, lng: -75.75039 })).toBe('14 Elkton Rd, Newark, DE 19711, USA');
    expect(nearestHouse([row('a', 1, { point: elkton })], { lat: 39.69, lng: -75.75 })).toBeNull();
    expect(nearestHouse([row('a', 1, { point: 'here' }), row('b', 2)], elkton)).toBeNull();
    expect(NEAR_M).toBe(60);
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
