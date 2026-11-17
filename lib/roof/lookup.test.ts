import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/takeoff.json';
import {
  addressKey,
  atticFloorM2,
  checkOnSite,
  compactTakeoff,
  deckM2,
  defaultFaces,
  faceGroup,
  facing,
  FT_PER_M,
  imageryText,
  isRoofResult,
  koalaWording,
  lookupAddress,
  M_PER_IN,
  mainPitch,
  mapFrame,
  mapZoom,
  mergeNotes,
  metersBetween,
  NO_ROOF_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  NOTES_HEADER,
  noteLine,
  offersUnmatched,
  pickSaved,
  pinBox,
  pitchText,
  project,
  QUALITY_WORDS,
  RESULT_FORMAT,
  roofFigures,
  roofJob,
  parseLatLng,
  roofRequestSchema,
  roundFt,
  roundSqft,
  satelliteQuerySchema,
  showUnmatched,
  SQFT_PER_M2,
  startPick,
  takeoffSchema,
  unproject,
  wallRunM,
  whenText,
  type RoofChoices,
  type RoofResult,
  type RoofSegment,
} from './lookup';

const clone = <T>(v: T): T => structuredClone(v);
const result = (): RoofResult => compactTakeoff(takeoffSchema.parse(clone(fixture)));
const seg = (n: number, rise: number, groundM2: number): RoofSegment => ({ n, rise, azimuthDeg: 180, areaM2: groundM2 * 1.1, groundM2, lowSlope: rise < 2, lower: false, center: null });
/** The fixture as a v1 server sends it: none of the v1.1 additions. */
function v1Answer() {
  const t = clone(fixture) as Record<string, unknown> & typeof fixture;
  const attic: Record<string, unknown> = { ...t.attic, wallRunM: 67.1 };
  for (const k of ['sharedWallM', 'unmatchedM2', 'perimeterByFaceM', 'deckM2']) delete attic[k];
  const segments = t.segments.map((s) => {
    const v1: Record<string, unknown> = { ...s };
    delete v1.lower;
    return v1;
  });
  return { ...t, attic, segments };
}
const choices = (overhangIn: number, excluded: number[], unmatchedOut = false): RoofChoices => ({ overhangIn, excluded, unmatchedOut });
/** The made-up house with 25 m² of the outline (a carport) that Google has no roof faces for. */
const withCarport = (): RoofResult => ({ ...result(), footprintM2: 242, unmatchedM2: 25 });

describe('units', () => {
  it('converts meters to feet and square meters to square feet', () => {
    expect(FT_PER_M).toBe(3.28084);
    expect(SQFT_PER_M2).toBe(10.7639);
    expect(FT_PER_M ** 2).toBeCloseTo(SQFT_PER_M2, 3);
    expect(12 * M_PER_IN).toBeCloseTo(0.3048, 10);
    expect(100 * SQFT_PER_M2).toBeCloseTo(1076.39, 6);
  });

  it('rounds square feet to tens and feet to whole feet', () => {
    expect(roundSqft(1966.75)).toBe(1970);
    expect(roundSqft(1364.9)).toBe(1360);
    expect(roundFt(220.02)).toBe(220);
  });
});

describe('the contract attic floor', () => {
  // A 40 x 30 ft roof seen from above with the walls set in by the overhang all the way round.
  const L = 40 / FT_PER_M;
  const W = 30 / FT_PER_M;
  const A = L * W;
  const P = 2 * (L + W);

  it('is the rectangle inside the overhang, for any overhang', () => {
    for (const inches of [0, 6, 12, 18, 24, 36]) {
      const d = inches * M_PER_IN;
      expect(atticFloorM2(A, P, d, 0)).toBeCloseTo((L - 2 * d) * (W - 2 * d), 9);
      expect(wallRunM(P, d)).toBeCloseTo(2 * (L - 2 * d + W - 2 * d), 9);
    }
    // 40 x 30 ft roof, 12" overhang: 38 x 28 ft of attic floor and 132 ft of wall.
    expect(atticFloorM2(A, P, 0.3048, 0) * SQFT_PER_M2).toBeCloseTo(38 * 28, 0);
    expect(wallRunM(P, 0.3048)! * FT_PER_M).toBeCloseTo(132, 1);
  });

  it('leaves out the share of the footprint over excluded faces', () => {
    const d = 0.3048;
    const all = atticFloorM2(A, P, d, 0);
    expect(atticFloorM2(A, P, d, A / 4)).toBeCloseTo(all * 0.75, 9);
    expect(atticFloorM2(A, P, d, A)).toBe(0);
    expect(atticFloorM2(A, P, d, A * 2)).toBe(0);
  });

  it('takes no overhang off along a neighbour\'s roof (twins, rowhouses), and no wall run there', () => {
    // A 20 x 40 ft twin half, sharing one 40 ft side: overhang on three sides only.
    const l = 20 / FT_PER_M;
    const w = 40 / FT_PER_M;
    const d = 0.3048;
    // The contract's formula keeps 4d² for the corners, so it is 2d² (2 sq ft) over the exact here.
    expect(atticFloorM2(l * w, 2 * (l + w), d, 0, w)).toBeCloseTo(l * w - (2 * l + w) * d + 4 * d * d, 9);
    expect(atticFloorM2(l * w, 2 * (l + w), d, 0, w) - (l - d) * (w - 2 * d)).toBeCloseTo(2 * d * d, 9);
    expect(wallRunM(2 * (l + w), d, w)! * FT_PER_M).toBeCloseTo(2 * 20 + 40 - 8, 6);
  });

  it('wall run leaves out the outer sides of the faces left out', () => {
    expect(wallRunM(70, 0.3048, 0, 10.9)).toBeCloseTo(70 - 10.9 - 8 * 0.3048, 9);
    expect(wallRunM(70, 0, 5, 10)).toBeCloseTo(55, 9);
    expect(wallRunM(20, 1, 0, 30)).toBe(0);
  });

  it('roof deck: the floor times the pitch factor of the faces kept, null with none kept', () => {
    expect(deckM2(100, [{ areaM2: 112, groundM2: 100 }])).toBeCloseTo(112, 9);
    // Area-weighted: 6/12 (1.118) over 80 m² and 12/12 (1.414) over 20 m².
    expect(deckM2(50, [{ areaM2: 80 * 1.118, groundM2: 80 }, { areaM2: 20 * 1.414, groundM2: 20 }])).toBeCloseTo(50 * ((80 * 1.118 + 20 * 1.414) / 100), 9);
    expect(deckM2(100, [])).toBeNull();
    expect(deckM2(100, [{ areaM2: 0, groundM2: 0 }])).toBeNull();
  });

  it('never goes below zero, and takes no overhang off when there is no perimeter (the contract formula, as Roof Takeoff does)', () => {
    expect(atticFloorM2(10, 100, 1, 0)).toBe(0);
    expect(atticFloorM2(0, 10, 0.3, 0)).toBe(0);
    // A − (P − S)·d + 4·d² with P = 0: Roof Takeoff's attic.floorM2 is this too.
    expect(atticFloorM2(200, 0, 0.3048, 50)).toBeCloseTo((200 + 4 * 0.3048 ** 2) * 0.75, 9);
    // A shared wall longer than the perimeter (a broken answer) counts as the whole perimeter, as on the server.
    expect(atticFloorM2(100, 40, 0.3, 0, 60)).toBeCloseTo(100 + 4 * 0.09, 9);
    expect(wallRunM(0, 0.3048)).toBeNull();
    expect(wallRunM(2, 1)).toBe(0);
  });
});

describe('takeoffSchema', () => {
  it('accepts a realistic answer, ignoring fields it does not use', () => {
    const parsed = takeoffSchema.parse(clone(fixture));
    expect(parsed.segments).toHaveLength(5);
    expect(parsed.edges).toHaveLength(4);
    expect('_fixture' in parsed).toBe(false);
    expect('box' in parsed.segments[0]!).toBe(false);
  });

  it('reads the v1.1 additions', () => {
    const parsed = takeoffSchema.parse(clone(fixture));
    expect(parsed.attic.perimeterByFaceM).toEqual({ '1': 16.4, '2': 20.1, '3': 14.5, '4': 7.4, '5': 10.9 });
    expect(parsed.attic.sharedWallM).toBe(0);
    expect(parsed.segments.map((x) => x.lower)).toEqual([false, false, true, true, true]);
  });

  it('still accepts a v1 answer, with none of the v1.1 additions', () => {
    const r = compactTakeoff(takeoffSchema.parse(v1Answer()));
    expect(r.sharedWallM).toBe(0);
    expect(r.unmatchedM2).toBe(0); // max(0, 217 - 217.1)
    expect(r.perimeterByFaceM).toEqual({});
    expect(r.segments.every((x) => x.lower === false)).toBe(true);
    expect(r.takeoff.deckM2).toBeNull();
    const f = roofFigures(r, choices(12, r.defaultExcluded));
    expect(roundSqft(f.floorSqft)).toBe(1970);
    expect(roundSqft(f.deckSqft!)).toBe(2170);
    // No breakdown by face: the porch's walls can't be taken off, so the v1 wall run.
    expect(roundFt(f.wallRunFt!)).toBe(220);
  });

  it('works out the parts with no roof data from a v1 answer', () => {
    const t = v1Answer();
    const r = compactTakeoff(takeoffSchema.parse({ ...t, attic: { ...t.attic, footprintM2: 240 } }));
    expect(r.unmatchedM2).toBeCloseTo(240 - 217.1, 9);
    expect(compactTakeoff(takeoffSchema.parse({ ...t, segments: [] })).unmatchedM2).toBe(0);
  });

  it('refuses broken v1.1 numbers instead of guessing', () => {
    const t = clone(fixture);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, sharedWallM: -1 } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, unmatchedM2: '12' } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, perimeterByFaceM: { one: 3 } } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, perimeterByFaceM: { '1': -3 } } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, deckM2: null } }).success).toBe(true);
  });

  it('accepts the gaps the contract allows: no outline, no faces, no dates, a pin instead of an address', () => {
    const t = clone(fixture) as Record<string, unknown> & typeof fixture;
    const bare = { ...t, outline: null, faces: [], edges: [], photo: null, place: { ...t.place, address: null, precision: 'PIN' }, building: { ...t.building, center: null, box: null, quality: null, imageryDate: null, faces: null, whole: null } };
    const r = compactTakeoff(takeoffSchema.parse(bare));
    expect(r.address).toBeNull();
    expect(r.outline).toEqual([]);
    expect(r.faces).toEqual([]);
    expect(r.box).toBeNull();
    expect(r.imagery).toBeNull();
    expect(r.center).toEqual(r.point);
  });

  it('drops a broken extra (map box, dates, warnings) instead of failing', () => {
    const t = clone(fixture);
    const broken = { ...t, building: { ...t.building, box: { sw: 'x' }, imageryDate: { year: 'June' } }, warnings: 'none', faces: [{ n: 'one' }] };
    const r = compactTakeoff(takeoffSchema.parse(broken));
    expect(r.box).toBeNull();
    expect(r.imagery).toEqual({ year: 2023, month: 6 }); // from the photo's date instead
    expect(r.warnings).toEqual([]);
    expect(r.faces).toEqual([]);
  });

  it('rejects an answer missing or breaking the numbers the attic floor comes from', () => {
    const t = clone(fixture);
    expect(takeoffSchema.safeParse({ ...t, attic: undefined }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, footprintM2: '217' } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, attic: { ...t.attic, perimeterM: -1 } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, segments: [{ ...t.segments[0], groundM2: null }] }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, segments: undefined }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, place: { ...t.place, lat: 91 } }).success).toBe(false);
    expect(takeoffSchema.safeParse({ ...t, version: 2 }).success).toBe(false);
    expect(takeoffSchema.safeParse({ error: 'Google has no roof data for this spot.' }).success).toBe(false);
    expect(takeoffSchema.safeParse(null).success).toBe(false);
  });
});

describe('roof edges', () => {
  it('keeps the edges and the total of every edge type', () => {
    const r = result();
    expect(r.edges).toHaveLength(4);
    expect(r.edges[0]).toEqual({ type: 'ridge', faces: [1, 2], lengthM: 15.2, planM: 15.2, path: fixture.edges[0]!.path });
    expect(r.edgeTotalsM).toEqual({ ridge: 15.2, hip: 0, valley: 4.4, eave: 22.6, rake: 0, step: 0, headwall: 0, break: 6.1 });
  });

  it('a total the answer leaves out is 0 (an older answer has no headwall)', () => {
    const t = clone(fixture) as Record<string, unknown> & typeof fixture;
    const totals: Record<string, unknown> = { ...t.edgeTotalsM };
    delete totals.headwall;
    delete totals.valley;
    const r = compactTakeoff(takeoffSchema.parse({ ...t, edgeTotalsM: totals }));
    expect(r.edgeTotalsM).toEqual({ ridge: 15.2, hip: 0, valley: 0, eave: 22.6, rake: 0, step: 0, headwall: 0, break: 6.1 });
  });

  it('adds the edges up when the answer sends no totals', () => {
    const t = clone(fixture) as Record<string, unknown> & typeof fixture;
    const edges = [...t.edges, { ...t.edges[0]!, lengthM: 4.8 }];
    delete (t as Record<string, unknown>).edgeTotalsM;
    const r = compactTakeoff(takeoffSchema.parse({ ...t, edges }));
    expect(r.edgeTotalsM.ridge).toBe(20);
    expect(r.edgeTotalsM.valley).toBe(4.4);
    expect(r.edgeTotalsM.hip).toBe(0);
  });

  it('still works without any edges (an answer from before edges were measured)', () => {
    const t = clone(fixture) as Record<string, unknown> & typeof fixture;
    delete (t as Record<string, unknown>).edges;
    delete (t as Record<string, unknown>).edgeTotalsM;
    const r = compactTakeoff(takeoffSchema.parse(t));
    expect(r.edges).toEqual([]);
    expect(Object.values(r.edgeTotalsM)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(isRoofResult(r)).toBe(true);
  });

  it('drops a broken edge on its own, and broken totals count as 0', () => {
    const t = clone(fixture);
    const edges = [
      ...t.edges,
      { ...t.edges[0], type: 'gutter' },
      { ...t.edges[0], lengthM: -1 },
      { ...t.edges[0], path: [t.edges[0]!.path[0]] },
      { ...t.edges[0], faces: 'both', planM: 'x' },
      null,
      'ridge',
    ];
    const r = compactTakeoff(takeoffSchema.parse({ ...t, edges, edgeTotalsM: { ...t.edgeTotalsM, ridge: '15', hip: -2 } }));
    expect(r.edges.map((e) => e.type)).toEqual(['ridge', 'eave', 'valley', 'break', 'ridge']);
    expect(r.edges.at(-1)).toMatchObject({ faces: [], planM: null });
    expect(r.edgeTotalsM.ridge).toBe(0);
    expect(r.edgeTotalsM.hip).toBe(0);
    expect(compactTakeoff(takeoffSchema.parse({ ...t, edges: 'none', edgeTotalsM: [] })).edges).toEqual([]);
  });

  it("a saved result from before the edges were kept isn't used again", () => {
    const r = result();
    const old: Record<string, unknown> = { ...r, format: 2 };
    delete old.edges;
    delete old.edgeTotalsM;
    expect(RESULT_FORMAT).toBe(3);
    expect(isRoofResult(old)).toBe(false);
    expect(isRoofResult({ ...r, edges: undefined })).toBe(false);
    expect(isRoofResult({ ...r, edgeTotalsM: null })).toBe(false);
  });
});

describe('compactTakeoff', () => {
  it('keeps what the app needs', () => {
    const r = result();
    expect(r.address).toBe('12 Elkton Rd, Newark, DE 19711, USA');
    expect(r.precision).toBe('RANGE_INTERPOLATED');
    expect(r.quality).toBe('MEDIUM');
    expect(r.imagery).toEqual({ year: 2023, month: 6 });
    expect(r.footprintM2).toBe(217);
    expect(r.perimeterM).toBe(69.5);
    expect(r.defaultExcluded).toEqual([5]);
    expect(r.segments.map((s) => [s.n, s.rise, s.lowSlope])).toEqual([[1, 6, false], [2, 6, false], [3, 4, false], [4, 4, false], [5, 1, true]]);
    expect(r.roofM2).toBeCloseTo(83.1 * 2 + 28.2 * 2 + 14.9, 9);
    expect(r.outline).toHaveLength(1);
    expect(r.outline[0]).toHaveLength(10);
    expect(r.faces.map((f) => f.n)).toEqual([1, 2, 3, 4, 5]);
    expect(r.segments[0]!.center).toEqual(fixture.segments[0]!.center);
    expect(r.warnings).toEqual(['Lower-detail imagery. Check the pitch on site.']);
    expect(r.takeoff).toEqual({ overhangM: 0.3048, floorM2: 182.7, wallRunM: 56.16, deckM2: 201.13 });
    expect(r.format).toBe(RESULT_FORMAT);
    expect(r.segments.map((x) => x.lower)).toEqual([false, false, true, true, true]);
    expect(r.perimeterByFaceM).toEqual({ '1': 16.4, '2': 20.1, '3': 14.5, '4': 7.4, '5': 10.9 });
    expect([r.sharedWallM, r.unmatchedM2]).toEqual([0, 0]);
    expect(isRoofResult(r)).toBe(true);
    expect(isRoofResult(JSON.parse(JSON.stringify(r)))).toBe(true);
  });

  it('takes the default faces from attic.excluded, not from the slope', () => {
    const t = clone(fixture);
    // A low-slope shed dormer (face 5 here) that Roof Takeoff keeps in, and a steep face it leaves out.
    const r = compactTakeoff(takeoffSchema.parse({ ...t, attic: { ...t.attic, excluded: [3] } }));
    expect(r.defaultExcluded).toEqual([3]);
    expect(defaultFaces(r, 'house')).toEqual({ excluded: [3], unmatchedOut: false });
    expect(compactTakeoff(takeoffSchema.parse({ ...t, attic: { ...t.attic, excluded: [] } })).defaultExcluded).toEqual([]);
  });

  it("drops face breakdowns for faces that aren't in the answer", () => {
    const t = clone(fixture);
    const r = compactTakeoff(takeoffSchema.parse({ ...t, attic: { ...t.attic, perimeterByFaceM: { '1': 3, '9': 4 } } }));
    expect(r.perimeterByFaceM).toEqual({ '1': 3 });
  });

  it("says Roof Takeoff's own-page steps in this app's terms", () => {
    expect(koalaWording('Google has no roof data for this spot. Tap the right roof on the image, or measure it from photos.')).toBe(
      'Google has no roof data for this spot. Wrong house? Tap the right roof under the photo.',
    );
    expect(koalaWording('Odd outline. Tap the right roof on the photo')).toBe('Odd outline. Wrong house? Tap the right roof under the photo.');
    expect(koalaWording('No faces, so measure this one from photos.')).toBe('No faces, so measure it with 📐 Measure this area.');
    expect(koalaWording('Lower-detail imagery. Check the pitch on site.')).toBe('Lower-detail imagery. Check the pitch on site.');
    const r = compactTakeoff(takeoffSchema.parse({ ...clone(fixture), warnings: ['Wrong building? Tap the right roof on the image.'] }));
    expect(r.warnings).toEqual(['Wrong building? Wrong house? Tap the right roof under the photo.']);
  });

  it('works out rise and low slope from the pitch when they are missing', () => {
    const t = clone(fixture);
    t.segments = t.segments.map((s) => ({ ...s, rise: undefined, lowSlope: undefined })) as unknown as typeof t.segments;
    const r = compactTakeoff(takeoffSchema.parse(t));
    expect(r.segments.map((s) => s.rise)).toEqual([6, 6, 4, 4, 1]);
    expect(r.segments.map((s) => s.lowSlope)).toEqual([false, false, false, false, true]);
  });

  it('ignores excluded faces that are not in the answer, thins long outlines and cleans warnings', () => {
    const t = clone(fixture);
    const ring = Array.from({ length: 1500 }, (_, i) => ({ lat: 39.68 + Math.sin(i / 240) * 1e-4, lng: -75.75 + Math.cos(i / 240) * 1e-4 }));
    const r = compactTakeoff(takeoffSchema.parse({ ...t, attic: { ...t.attic, excluded: [5, 9, 5] }, outline: { ...t.outline, polys: [ring, ring.slice(0, 2)] }, warnings: ['  Two\n lines ', '', 'x'.repeat(400)] }));
    expect(r.defaultExcluded).toEqual([5]);
    expect(r.outline).toHaveLength(1);
    expect(r.outline[0]!.length).toBeLessThanOrEqual(600);
    expect(r.warnings).toEqual(['Two lines', 'x'.repeat(300)]);
  });

  it('uses Solar’s whole-roof area when there are no faces', () => {
    const r = compactTakeoff(takeoffSchema.parse({ ...clone(fixture), segments: [] }));
    expect(r.roofM2).toBe(fixture.building.faces.areaM2);
    expect(r.segments).toEqual([]);
  });
});

describe('roofFigures', () => {
  it('gives the made-up house its numbers at the default 12" overhang, porch left out', () => {
    const r = result();
    const f = roofFigures(r, choices(12, r.defaultExcluded));
    expect(roundSqft(f.floorSqft)).toBe(1970);
    // Roof deck over that floor: 1,966.7 x (222.6 / 202.2) for faces 1 to 4.
    expect(roundSqft(f.deckSqft!)).toBe(2170);
    expect(f.deckSqft!).toBeCloseTo(f.floorSqft * ((83.1 * 2 + 28.2 * 2) / (74.3 * 2 + 26.8 * 2)), 9);
    expect(roundSqft(f.wholeRoofSqft)).toBe(2560);
    expect(roundSqft(f.footprintSqft)).toBe(2340);
    // 69.5 m less the porch's 10.9 m of outline, less 8 x 12": 56.2 m.
    expect(roundFt(f.wallRunFt!)).toBe(184);
    expect(f.wallRunRough).toBe(false);
    expect(f.mainPitch).toBe(6);
    expect(roundSqft(f.excludedSqft)).toBe(160);
    expect(f.facesKept).toBe(4);
    // The same as Roof Takeoff's own figures at its 12" overhang.
    expect(f.floorSqft / SQFT_PER_M2).toBeCloseTo(r.takeoff.floorM2, 1);
    expect(f.wallRunFt! / FT_PER_M).toBeCloseTo(r.takeoff.wallRunM, 1);
    expect(f.deckSqft! / SQFT_PER_M2).toBeCloseTo(r.takeoff.deckM2!, 1);
  });

  it('recomputes for another overhang and other faces left out; the whole roof never changes', () => {
    const r = result();
    const base = roofFigures(r, choices(12, [5]));
    const wider = roofFigures(r, choices(18, [5]));
    const noGarage = roofFigures(r, choices(18, [3, 4, 5]));
    const everything = roofFigures(r, choices(0, []));
    expect(wider.floorSqft).toBeLessThan(base.floorSqft);
    expect(roundSqft(wider.floorSqft)).toBe(1870);
    expect(roundFt(wider.wallRunFt!)).toBe(180);
    expect(roundSqft(noGarage.floorSqft)).toBe(1370);
    // Faces 1 and 2 only, both 6/12: the deck is the floor times 83.1 / 74.3.
    expect(noGarage.deckSqft!).toBeCloseTo(noGarage.floorSqft * (83.1 / 74.3), 9);
    // The garage's 21.9 m and the porch's 10.9 m of outline come off the wall run.
    expect(roundFt(noGarage.wallRunFt!)).toBe(108);
    expect(everything.floorSqft).toBeCloseTo(everything.footprintSqft, 9);
    expect(roundFt(everything.wallRunFt!)).toBe(228);
    for (const f of [wider, noGarage, everything]) expect(f.wholeRoofSqft).toBe(base.wholeRoofSqft);
  });

  it('has no roof deck with every face off', () => {
    const r = result();
    const f = roofFigures(r, choices(12, [1, 2, 3, 4, 5]));
    expect(f.deckSqft).toBeNull();
    expect(f.facesKept).toBe(0);
  });

  it('leaves out the parts with no roof data only when asked', () => {
    const r = withCarport();
    const kept = roofFigures(r, choices(12, [5]));
    const out = roofFigures(r, choices(12, [5], true));
    expect(out.excludedSqft - kept.excludedSqft).toBeCloseTo(25 * SQFT_PER_M2, 6);
    expect(out.floorSqft).toBeLessThan(kept.floorSqft);
    const A = 242;
    const floorAll = A - 69.5 * 0.3048 + 4 * 0.3048 ** 2;
    expect(out.floorSqft / SQFT_PER_M2).toBeCloseTo(floorAll * (1 - (14.9 + 25) / A), 9);
    // The wall run counts faces' outer sides only.
    expect(out.wallRunFt).toBe(kept.wallRunFt);
    expect(roundSqft(kept.unmatchedSqft)).toBe(270);
  });

  it('takes no overhang off along a neighbour, for the floor and the wall run', () => {
    const r = { ...result(), sharedWallM: 10 };
    const f = roofFigures(r, choices(12, []));
    expect(f.floorSqft / SQFT_PER_M2).toBeCloseTo(217 - (69.5 - 10) * 0.3048 + 4 * 0.3048 ** 2, 9);
    expect(f.wallRunFt! / FT_PER_M).toBeCloseTo(69.5 - 10 - 8 * 0.3048, 9);
  });

  it('says when the wall run is rough (estimated from the building box)', () => {
    expect(roofFigures({ ...result(), perimeterSource: 'box' }, choices(12, [5])).wallRunRough).toBe(true);
    expect(roofFigures({ ...result(), perimeterM: 0, perimeterSource: 'none' }, choices(12, [5])).wallRunFt).toBeNull();
  });
});

describe('the parts with no roof data', () => {
  it('are offered over 5% of the footprint and over 5 m², not for walls, not without faces', () => {
    const r = result();
    expect(showUnmatched(r)).toBe(false);
    expect(showUnmatched(withCarport())).toBe(true);
    expect(showUnmatched({ ...r, footprintM2: 400, unmatchedM2: 19 })).toBe(false); // under 5% of 400
    expect(showUnmatched({ ...r, footprintM2: 60, unmatchedM2: 4.9 })).toBe(false); // under 5 m²
    expect(showUnmatched({ ...r, footprintM2: 60, unmatchedM2: 5.1 })).toBe(true);
    expect(showUnmatched({ ...r, segments: [], unmatchedM2: 217 })).toBe(false);
    expect(offersUnmatched(withCarport(), 'attic')).toBe(true);
    expect(offersUnmatched(withCarport(), 'walls')).toBe(false);
  });
});

describe('what each area uses', () => {
  it('attic and commercial areas choose attic floor or roof deck; the rest have one number', () => {
    expect(roofJob('attic')).toBe('attic');
    expect(roofJob('commercial')).toBe('attic');
    expect(roofJob('crawlspace')).toBe('crawlspace');
    expect(roofJob('garage')).toBe('garage');
    expect(roofJob('walls')).toBe('walls');
    expect(roofJob('rim_joist')).toBeNull();
  });

  it('starts on the roof deck when the area is measured on the roofline, else the attic floor', () => {
    expect(startPick(undefined)).toBe('floor');
    expect(startPick({ mode: 'floor' })).toBe('floor');
    expect(startPick({ mode: 'roofline' })).toBe('deck');
    expect(startPick({ mode: 'walls' })).toBe('floor');
  });

  it('a garage starts with every face off (and the parts with no roof data); the house with Roof Takeoff’s choice', () => {
    const r = result();
    expect(faceGroup('garage')).toBe('garage');
    expect(faceGroup('attic')).toBe('house');
    expect(faceGroup('walls')).toBe('house');
    expect(faceGroup('crawlspace')).toBe('house');
    expect(defaultFaces(r, 'garage')).toEqual({ excluded: [1, 2, 3, 4, 5], unmatchedOut: true });
    expect(defaultFaces(r, 'house')).toEqual({ excluded: [5], unmatchedOut: false });
    const none = roofFigures(r, { overhangIn: 12, ...defaultFaces(r, 'garage') });
    expect(none.floorSqft).toBe(0);
    // The garage's two 4/12 faces turned on: its share of the footprint inside the walls.
    const garage = roofFigures(r, choices(12, [1, 2, 5], true));
    expect(roundSqft(garage.floorSqft)).toBe(520);
  });
});

describe('check on site', () => {
  it('lists the rough placement until the house is confirmed, then the rest and Roof Takeoff’s warnings', () => {
    const r = result();
    const f = roofFigures(r, choices(12, [5]));
    expect(checkOnSite(r, f, 'attic', false)).toEqual([
      "Google placed this address roughly, so the outline may be on a neighbour's house. Check it on the photo below.",
      'Lower-detail imagery. Check the pitch on site.',
    ]);
    expect(checkOnSite(r, f, 'attic', true)).toEqual(['Lower-detail imagery. Check the pitch on site.']);
    expect(checkOnSite({ ...r, precision: 'ROOFTOP', warnings: [] }, f, 'attic', false)).toEqual([]);
    expect(checkOnSite({ ...r, precision: 'PIN', warnings: [] }, f, 'attic', false)).toEqual(['Check the white outline is on the roof you tapped.']);
  });

  it('adds a blurry photo, no outline, a rough wall run, no faces and the parts with no roof data', () => {
    const base = { ...result(), precision: 'ROOFTOP', warnings: [] };
    const f = (r: RoofResult) => roofFigures(r, choices(12, []));
    expect(checkOnSite({ ...base, quality: 'LOW' }, f(base), 'attic', true)).toEqual(['Blurry photo: check the sizes and the pitch on site.']);
    // Roof Takeoff's own line for the same blurry photo isn't repeated; its other warnings are kept.
    const theirs = ['Lower-detail imagery. Check the pitch on site.', 'Mostly flat or low-slope roof. Check whether there is an attic at all.'];
    expect(checkOnSite({ ...base, quality: 'LOW', warnings: theirs }, f(base), 'attic', true)).toEqual([
      'Blurry photo: check the sizes and the pitch on site.',
      'Mostly flat or low-slope roof. Check whether there is an attic at all.',
    ]);
    expect(checkOnSite({ ...base, perimeterSource: 'none' }, f(base), 'attic', true)[0]).toMatch(/overhang can't be taken off/);
    const box = { ...base, perimeterSource: 'box' };
    expect(checkOnSite(box, f(box), 'walls', true)).toEqual(["No outline was traced, so the wall run is rough: from the building's size. Measure it on site."]);
    expect(checkOnSite(box, f(box), 'attic', true)).toEqual([]);
    expect(checkOnSite({ ...base, segments: [] }, f(base), 'attic', true)).toEqual(['Google has no roof faces for this house, so no faces can be left out.']);
    const carport = { ...withCarport(), precision: 'ROOFTOP', warnings: [] };
    expect(checkOnSite(carport, f(carport), 'attic', true)).toEqual(["270 sq ft of the outline has no roof data (a carport or flat part?). Turn it off below if it isn't over the attic."]);
    expect(checkOnSite(carport, f(carport), 'garage', true)[0]).toMatch(/Turn it on below if it is part of the garage\.$/);
    expect(checkOnSite(carport, f(carport), 'walls', true)).toEqual([]);
  });

  it('has its own words on paper: no photo below, nothing to turn off', () => {
    const r = result();
    const f = roofFigures(r, choices(12, [5]));
    expect(checkOnSite(r, f, 'attic', false, true)).toEqual([
      "Not confirmed: Google placed this address roughly, so the outline may be on a neighbour's house.",
      'Lower-detail imagery. Check the pitch on site.',
    ]);
    expect(checkOnSite({ ...r, precision: 'PIN', warnings: [] }, f, 'attic', false, true)).toEqual(['Not confirmed: a roof picked on the photo, not checked as the house.']);
    expect(checkOnSite({ ...r, precision: 'PIN', warnings: [] }, f, 'attic', true, true)).toEqual([]);
    const carport = { ...withCarport(), precision: 'ROOFTOP', warnings: [] };
    expect(checkOnSite(carport, roofFigures(carport, choices(12, [])), 'attic', true, true)).toEqual(['270 sq ft of the outline has no roof data (a carport or flat part?).']);
    for (const w of [...checkOnSite(r, f, 'attic', false, true), ...checkOnSite(carport, roofFigures(carport, choices(12, [])), 'attic', false, true)]) {
      expect(w).not.toMatch(/below|white outline|you tapped/);
    }
  });
});

describe('words', () => {
  it('main pitch: the whole-number rise with the most ground', () => {
    expect(mainPitch([seg(1, 6.2, 50), seg(2, 5.8, 50), seg(3, 12, 80), seg(4, 1, 5)])).toBe(6);
    expect(mainPitch([seg(1, 12, 80), seg(2, 6, 50)])).toBe(12);
    // A nearly flat roof is said in tenths, as pitchText says it: 0.5/12, not 1/12 or 0/12.
    expect(mainPitch([seg(1, 0.5, 300), seg(2, 8, 100)])).toBe(0.5);
    expect(mainPitch([seg(1, 0.3, 300)])).toBe(0.3);
    expect(mainPitch([seg(1, 1.96, 60), seg(2, 2.4, 50), seg(3, 6, 100)])).toBe(2);
    expect(mainPitch([])).toBeNull();
  });

  it('pitch and direction', () => {
    expect(pitchText(6.04)).toBe('6/12');
    expect(pitchText(1.46)).toBe('1.5/12');
    expect(facing(172, 6)).toBe('faces south');
    expect(facing(352, 6)).toBe('faces north');
    expect(facing(-90, 6)).toBe('faces west');
    expect(facing(225, 6)).toBe('faces southwest');
    expect(facing(180, 0.2)).toBe('flat');
  });

  it('imagery month', () => {
    expect(imageryText(result())).toBe('Jun 2023');
    expect(imageryText({ imagery: null })).toBeNull();
  });

  it('photo badge: the blurry photo is amber, never calmer than a good one', () => {
    expect(QUALITY_WORDS.HIGH).toEqual({ label: 'Sharp photo', tone: 'green' });
    expect(QUALITY_WORDS.MEDIUM).toEqual({ label: 'Good photo', tone: 'slate' });
    expect(QUALITY_WORDS.LOW).toEqual({ label: 'Blurry photo: check on site', tone: 'amber' });
  });

  it('plain words for the estimator: no setup jargon, no steps this app does not have', () => {
    expect(NOT_CONFIGURED_MESSAGE).toBe("Satellite lookup isn't set up yet. Ask the office.");
    expect(NO_ROOF_MESSAGE).toBe('Google has no roof data for this house. Measure it with 📐 Measure this area.');
  });

  it('when a saved lookup was made', () => {
    const now = new Date(2026, 10, 17, 15, 30);
    expect(whenText(new Date(2026, 10, 17, 14, 5), now)).toBe('today 2:05 PM');
    expect(whenText(new Date(2026, 10, 16, 9, 40), now)).toBe('yesterday 9:40 AM');
    expect(whenText(new Date(2026, 10, 14, 9, 40), now)).toBe('Nov 14, 9:40 AM');
  });
});

describe('applying', () => {
  it('needs a whole address', () => {
    expect(lookupAddress({ street: ' 12  Elkton Rd ', city: 'Newark', state: 'de', zip: '19711' })).toBe('12 Elkton Rd, Newark, DE 19711');
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711-1234' })).toBe('12 Elkton Rd, Newark, DE 19711-1234');
    expect(lookupAddress({ street: '', city: 'Newark', state: 'DE', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: ' ', state: 'DE', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'D', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '1971' })).toBeNull();
    expect(lookupAddress({ street: 'x'.repeat(200), city: 'Newark', state: 'DE', zip: '19711' })).toBeNull();
  });

  it('writes a prep-note line that says what the number is and what was left out', () => {
    const r = result();
    const at = (c: RoofChoices) => roofFigures(r, c);
    const c12 = choices(12, [5]);
    expect(noteLine(r, at(c12), c12, 'attic', 'floor')).toBe(
      '• Satellite (Google imagery Jun 2023): attic floor about 1,970 sq ft inside the walls (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
    expect(noteLine(r, at(c12), c12, 'attic', 'deck')).toBe(
      '• Satellite (Google imagery Jun 2023): roof deck about 2,170 sq ft over the attic floor (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
    const c18 = choices(18, [3, 4, 5]);
    expect(noteLine(r, at(c18), c18, 'attic', 'floor')).toBe(
      '• Satellite (Google imagery Jun 2023): attic floor about 1,370 sq ft inside the walls (18-inch eaves removed; left out faces 3 at 4/12, 4 at 4/12 and 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
    expect(noteLine(r, at(c12), c12, 'crawlspace')).toMatch(/: crawlspace floor about 1,970 sq ft inside the walls \(12-inch eaves removed; left out face 5 at 1\/12\)\./);
    expect(noteLine(r, at(c12), c12, 'walls')).toBe(
      '• Satellite (Google imagery Jun 2023): wall run about 184 ft (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
    const garage = choices(12, [1, 2, 5], true);
    expect(noteLine(r, at(garage), garage, 'garage')).toBe(
      '• Satellite (Google imagery Jun 2023): garage ceiling about 520 sq ft inside the walls (12-inch eaves removed; from faces 3 at 4/12 and 4 at 4/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
    const none = choices(0, []);
    expect(noteLine({ ...r, imagery: null }, at(none), none, 'attic')).toBe(
      '• Satellite (Google imagery): attic floor about 2,340 sq ft inside the walls (no overhang removed). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.',
    );
  });

  it('says in the note when the wall run is rough, the neighbour wall and the parts with no roof data', () => {
    const box = { ...result(), perimeterSource: 'box' };
    const c = choices(12, [5]);
    expect(noteLine(box, roofFigures(box, c), c, 'walls')).toMatch(/wall run about 184 ft, rough: from the building's size \(/);
    const twin = { ...result(), sharedWallM: 10 };
    expect(noteLine(twin, roofFigures(twin, c), c, 'attic')).toMatch(/\(12-inch eaves removed; no overhang along the neighbour; left out face 5 at 1\/12\)/);
    const carport = withCarport();
    const out = choices(12, [5], true);
    expect(noteLine(carport, roofFigures(carport, out), out, 'attic')).toMatch(/left out face 5 at 1\/12 and 270 sq ft with no roof data\)/);
    expect(noteLine(carport, roofFigures(carport, out), out, 'walls')).toMatch(/left out face 5 at 1\/12\)/);
    const garageWith = choices(12, [1, 2, 5], false);
    expect(noteLine(carport, roofFigures(carport, garageWith), garageWith, 'garage')).toMatch(/from faces 3 at 4\/12 and 4 at 4\/12 plus 270 sq ft with no roof data\)/);
  });
});

describe('mergeNotes', () => {
  const line = '• Satellite (Google imagery Jun 2023): attic floor about 1,970 sq ft inside the walls (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.';
  const later = '• Satellite (Google imagery Jun 2023): roof deck about 2,170 sq ft over the attic floor (12-inch eaves removed; left out face 5 at 1/12). Whole roof 2,560 sq ft incl. overhangs, main pitch 6/12. Check on site.';
  const older = '• Satellite (Google, Jun 2023): attic floor about 1,970 sq ft with a 12-inch overhang; roof surface about 2,560 sq ft at 6/12.';

  it('adds the header and the line to empty or existing notes', () => {
    expect(mergeNotes(null, line)).toBe(`${NOTES_HEADER}\n${line}`);
    expect(mergeNotes('Dog in the yard.\n\n', line)).toBe(`Dog in the yard.\n${NOTES_HEADER}\n${line}`);
  });

  it('replaces the earlier satellite line under the same header and keeps everything else', () => {
    const notes = ['Dog in the yard.', NOTES_HEADER, line, 'From photo read:', '• Caution: Recessed lights'].join('\n');
    expect(mergeNotes(notes, later)).toBe(['Dog in the yard.', NOTES_HEADER, later, 'From photo read:', '• Caution: Recessed lights'].join('\n'));
    expect(mergeNotes(mergeNotes(notes, line), line)).toBe(notes);
    expect(mergeNotes(notes, later).split(NOTES_HEADER)).toHaveLength(2);
  });

  it('replaces a line in the earlier wording too', () => {
    expect(mergeNotes(`${NOTES_HEADER}\n${older}`, line)).toBe(`${NOTES_HEADER}\n${line}`);
  });

  it('stays within the notes limit', () => {
    expect(mergeNotes('x'.repeat(1990), line)).toHaveLength(2000);
  });
});

describe('the map', () => {
  it('projects to Web Mercator and back', () => {
    expect(project({ lat: 0, lng: 0 }, 0)).toEqual({ x: 128, y: 128 });
    expect(project({ lat: 0, lng: 180 }, 1).x).toBe(512);
    for (const p of [{ lat: 39.6834, lng: -75.7504 }, { lat: -33.86, lng: 151.21 }, { lat: 0, lng: 0 }]) {
      for (const z of [0, 16, 20]) {
        const q = project(p, z);
        const back = unproject(q.x, q.y, z);
        expect(back.lat).toBeCloseTo(p.lat, 9);
        expect(back.lng).toBeCloseTo(p.lng, 9);
      }
    }
  });

  it('centers the view and maps points to its 640 pixels', () => {
    const r = result();
    const view = mapFrame(r.center, 20);
    expect(view.toPx(r.center)).toEqual({ x: 320, y: 320 });
    const sw = view.toPx(r.box!.sw);
    const ne = view.toPx(r.box!.ne);
    expect(sw.x).toBeLessThan(320);
    expect(sw.y).toBeGreaterThan(320); // south is down
    expect(ne.x).toBeGreaterThan(320);
    const back = view.toLatLng(ne.x, ne.y);
    expect(back.lat).toBeCloseTo(r.box!.ne.lat, 9);
    expect(back.lng).toBeCloseTo(r.box!.ne.lng, 9);
  });

  it('zooms so the building fills about half the view, from 16 to 20', () => {
    const r = result();
    const z = mapZoom(r.box);
    expect(z).toBe(20);
    // About 23 m across: 640 * 0.55 / span at zoom 0, as the Roof Takeoff site does.
    const a = project(r.box!.sw, 0);
    const b = project(r.box!.ne, 0);
    expect(z).toBe(Math.min(20, Math.floor(Math.log2((640 * 0.55) / Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y))))));
    const big = { sw: { lat: 39.68, lng: -75.76 }, ne: { lat: 39.6812, lng: -75.757 } }; // about 260 m across
    expect(mapZoom(big)).toBe(17);
    expect(mapZoom({ sw: { lat: 39, lng: -76 }, ne: { lat: 40, lng: -75 } })).toBe(16);
    expect(mapZoom(null)).toBe(20);
  });
});

describe('requests', () => {
  it('checks a lookup request', () => {
    const ok = { estimateId: '00000000-0000-4000-8000-000000000001', areaId: '00000000-0000-4000-8000-000000000002', address: '  12 Elkton Rd, Newark, DE 19711 ' };
    expect(roofRequestSchema.parse(ok)).toEqual({ ...ok, address: '12 Elkton Rd, Newark, DE 19711' });
    expect(roofRequestSchema.safeParse({ ...ok, address: '12' }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ ...ok, address: 'x'.repeat(201) }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ ...ok, areaId: 'nope' }).success).toBe(false);
    expect(roofRequestSchema.parse({ ...ok, fresh: true })).toMatchObject({ fresh: true });
    expect(roofRequestSchema.safeParse({ ...ok, fresh: 'yes' }).success).toBe(false);
  });

  it('takes a lookup with no estimate or area (the Roof lookup page), but checks ids that are sent', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    expect(roofRequestSchema.parse({ address: '3 Cross Gable Ct, Newark, DE' })).toEqual({ address: '3 Cross Gable Ct, Newark, DE' });
    expect(roofRequestSchema.parse({ lat: 39.68, lng: -75.75, fresh: true })).toEqual({ lat: 39.68, lng: -75.75, fresh: true });
    expect(roofRequestSchema.parse({ estimateId: id, address: '3 Cross Gable Ct' })).toEqual({ estimateId: id, address: '3 Cross Gable Ct' });
    expect(roofRequestSchema.safeParse({ estimateId: 'nope', address: '3 Cross Gable Ct' }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ areaId: '', address: '3 Cross Gable Ct' }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ estimateId: null, address: '3 Cross Gable Ct' }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ address: '3 Cross Gable Ct', extra: 1 }).success).toBe(false);
    expect(roofRequestSchema.safeParse({}).success).toBe(false);
  });

  it('reads a spot sent as text ("lat,lng", from an old Roof Takeoff map-pin link)', () => {
    expect(parseLatLng('39.6834,-75.7504')).toEqual({ lat: 39.6834, lng: -75.7504 });
    expect(parseLatLng(' 39.68347 , -75.75039 ')).toEqual({ lat: 39.68347, lng: -75.75039 });
    expect(parseLatLng('-33.8,151')).toEqual({ lat: -33.8, lng: 151 });
    for (const odd of ['12 Elkton Rd, Newark, DE 19711', '91.2,-75.75', '39.68,-181', '39.68', '39.68,-75.75,3', 'Newark, 19711', '39.68 -75.75', '']) {
      expect(parseLatLng(odd), odd).toBeNull();
    }
  });

  it('checks a lookup of a spot on the map: finite, latitude within 90 and longitude within 180', () => {
    const ids = { estimateId: '00000000-0000-4000-8000-000000000001', areaId: '00000000-0000-4000-8000-000000000002' };
    expect(roofRequestSchema.parse({ ...ids, lat: 39.68347, lng: -75.75039 })).toEqual({ ...ids, lat: 39.68347, lng: -75.75039 });
    expect(roofRequestSchema.safeParse({ ...ids, lat: 90, lng: -180 }).success).toBe(true);
    for (const bad of [{ lat: 90.1, lng: 0 }, { lat: 0, lng: 180.5 }, { lat: -91, lng: 0 }, { lat: '39.6', lng: -75.7 }, { lat: Infinity, lng: 0 }, { lat: Number.NaN, lng: 0 }, { lat: 39.6 }]) {
      expect(roofRequestSchema.safeParse({ ...ids, ...bad }).success).toBe(false);
    }
    // One or the other, not both.
    expect(roofRequestSchema.safeParse({ ...ids, lat: 39.6, lng: -75.7, address: '12 Elkton Rd, Newark, DE 19711' }).success).toBe(false);
  });

  it('checks a satellite request: coordinates and a whole zoom from 16 to 20', () => {
    expect(satelliteQuerySchema.parse({ lat: '39.6834', lng: '-75.7504', zoom: '20' })).toEqual({ lat: 39.6834, lng: -75.7504, zoom: 20 });
    expect(satelliteQuerySchema.safeParse({ lat: null, lng: '-75.7504', zoom: '20' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '', lng: '-75.7504', zoom: '20' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '91', lng: '-75.7504', zoom: '20' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '39.6', lng: '1e3', zoom: '20' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '39.6', lng: '-75.7', zoom: '15' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '39.6', lng: '-75.7', zoom: '21' }).success).toBe(false);
    expect(satelliteQuerySchema.safeParse({ lat: '39.6', lng: '-75.7', zoom: '18.5' }).success).toBe(false);
  });
});

describe('using a saved lookup again', () => {
  it('matches an address however it was typed', () => {
    expect(addressKey('  12 Elkton Rd,  Newark, DE 19711 ')).toBe('12 elkton rd newark de 19711');
    expect(addressKey('12 ELKTON RD NEWARK,DE   19711')).toBe(addressKey('12 Elkton Rd, Newark, DE 19711'));
    expect(addressKey('12 Elkton Rd, Newark, DE 19711')).not.toBe(addressKey('14 Elkton Rd, Newark, DE 19711'));
  });

  it('measures short distances between pins', () => {
    const a = { lat: 39.6834, lng: -75.7504 };
    expect(metersBetween(a, a)).toBe(0);
    expect(metersBetween(a, { lat: 39.6834 + 1e-5, lng: -75.7504 })).toBeCloseTo(1.11, 2);
    expect(metersBetween(a, { lat: 39.6834, lng: -75.7504 + 1e-5 })).toBeCloseTo(0.856, 2);
    const { dLat, dLng } = pinBox(a, 2);
    expect(metersBetween(a, { lat: a.lat + dLat, lng: a.lng })).toBeGreaterThan(2);
    expect(metersBetween(a, { lat: a.lat, lng: a.lng + dLng })).toBeGreaterThan(2);
    expect(metersBetween(a, { lat: a.lat, lng: a.lng + dLng })).toBeLessThan(2.1);
  });

  it('picks the newest saved result this app can read, for a pin within 2 m', () => {
    const r = result();
    const row = (id: string, extra: Record<string, unknown> = {}) => ({ id, created_at: '2026-11-17T10:00:00Z', result: r, ...extra });
    expect(pickSaved([row('a'), row('b')], null)?.id).toBe('a');
    expect(pickSaved([row('old', { result: { footprintM2: 217 } }), row('b')], null)?.id).toBe('b');
    expect(pickSaved([row('old', { result: { ...r, format: 1 } })], null)).toBeNull();
    expect(pickSaved([], null)).toBeNull();
    const pin = { lat: 39.6834, lng: -75.7504 };
    expect(pickSaved([row('far', { pin_lat: 39.6834 + 3e-5, pin_lng: -75.7504 }), row('near', { pin_lat: 39.6834 + 1e-5, pin_lng: -75.7504 })], pin)?.id).toBe('near');
    expect(pickSaved([row('address only')], pin)).toBeNull();
  });
});
