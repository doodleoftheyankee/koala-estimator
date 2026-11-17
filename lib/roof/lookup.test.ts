import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/takeoff.json';
import {
  atticFloorM2,
  compactTakeoff,
  facing,
  FT_PER_M,
  imageryText,
  lookupAddress,
  M_PER_IN,
  mainPitch,
  mapFrame,
  mapZoom,
  mergeNotes,
  NOTES_HEADER,
  noteLine,
  pitchText,
  project,
  roofFigures,
  roofRequestSchema,
  roofUse,
  roundFt,
  roundSqft,
  satelliteQuerySchema,
  SQFT_PER_M2,
  takeoffSchema,
  unproject,
  wallRunM,
  type RoofResult,
  type RoofSegment,
} from './lookup';

const clone = <T>(v: T): T => structuredClone(v);
const result = (): RoofResult => compactTakeoff(takeoffSchema.parse(clone(fixture)));
const seg = (n: number, rise: number, groundM2: number): RoofSegment => ({ n, rise, azimuthDeg: 180, areaM2: groundM2 * 1.1, groundM2, lowSlope: rise < 2, center: null });

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

  it('never goes below zero, and uses the footprint when there is no perimeter', () => {
    expect(atticFloorM2(10, 100, 1, 0)).toBe(0);
    expect(atticFloorM2(0, 10, 0.3, 0)).toBe(0);
    expect(atticFloorM2(200, 0, 0.3048, 50)).toBeCloseTo(150, 9);
    expect(wallRunM(0, 0.3048)).toBeNull();
    expect(wallRunM(2, 1)).toBe(0);
  });
});

describe('takeoffSchema', () => {
  it('accepts a realistic answer, ignoring fields it does not use', () => {
    const parsed = takeoffSchema.parse(clone(fixture));
    expect(parsed.segments).toHaveLength(5);
    expect('edges' in parsed).toBe(false);
    expect('_fixture' in parsed).toBe(false);
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
    expect(r.takeoff).toEqual({ overhangM: 0.3048, floorM2: 182.7, wallRunM: 67.1 });
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
    const f = roofFigures(r, { overhangIn: 12, excluded: r.defaultExcluded });
    expect(roundSqft(f.atticFloorSqft)).toBe(1970);
    expect(roundSqft(f.roofSqft)).toBe(2560);
    expect(roundSqft(f.footprintSqft)).toBe(2340);
    expect(roundFt(f.wallRunFt!)).toBe(220);
    expect(f.mainPitch).toBe(6);
    expect(roundSqft(f.excludedSqft)).toBe(160);
    // The same as Roof Takeoff's own figure at its 12" overhang.
    expect(f.atticFloorSqft / SQFT_PER_M2).toBeCloseTo(r.takeoff.floorM2, 1);
    expect(f.wallRunFt! / FT_PER_M).toBeCloseTo(r.takeoff.wallRunM, 1);
  });

  it('recomputes for another overhang and other faces left out; the roof surface never changes', () => {
    const r = result();
    const base = roofFigures(r, { overhangIn: 12, excluded: [5] });
    const wider = roofFigures(r, { overhangIn: 18, excluded: [5] });
    const noGarage = roofFigures(r, { overhangIn: 18, excluded: [3, 4, 5] });
    const everything = roofFigures(r, { overhangIn: 0, excluded: [] });
    expect(wider.atticFloorSqft).toBeLessThan(base.atticFloorSqft);
    expect(roundSqft(wider.atticFloorSqft)).toBe(1870);
    expect(roundSqft(noGarage.atticFloorSqft)).toBe(1370);
    expect(roundFt(noGarage.wallRunFt!)).toBe(216);
    expect(everything.atticFloorSqft).toBeCloseTo(everything.footprintSqft, 9);
    for (const f of [wider, noGarage, everything]) expect(f.roofSqft).toBe(base.roofSqft);
  });
});

describe('words', () => {
  it('main pitch: the whole-number rise with the most ground', () => {
    expect(mainPitch([seg(1, 6.2, 50), seg(2, 5.8, 50), seg(3, 12, 80), seg(4, 1, 5)])).toBe(6);
    expect(mainPitch([seg(1, 12, 80), seg(2, 6, 50)])).toBe(12);
    expect(mainPitch([seg(1, 0.5, 300), seg(2, 8, 100)])).toBe(1);
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
});

describe('applying', () => {
  it('fills the floor, the roof surface for a roofline measurement, or the wall run', () => {
    expect(roofUse('attic', undefined)).toBe('floor');
    expect(roofUse('attic', { mode: 'floor' })).toBe('floor');
    expect(roofUse('attic', { mode: 'roofline' })).toBe('roof');
    expect(roofUse('garage', { mode: 'roofline' })).toBe('roof');
    expect(roofUse('walls', { mode: 'walls' })).toBe('walls');
    expect(roofUse('walls', undefined)).toBe('walls');
    expect(roofUse('rim_joist', undefined)).toBeNull();
  });

  it('needs a whole address', () => {
    expect(lookupAddress({ street: ' 12  Elkton Rd ', city: 'Newark', state: 'de', zip: '19711' })).toBe('12 Elkton Rd, Newark, DE 19711');
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '19711-1234' })).toBe('12 Elkton Rd, Newark, DE 19711-1234');
    expect(lookupAddress({ street: '', city: 'Newark', state: 'DE', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: ' ', state: 'DE', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'D', zip: '19711' })).toBeNull();
    expect(lookupAddress({ street: '12 Elkton Rd', city: 'Newark', state: 'DE', zip: '1971' })).toBeNull();
    expect(lookupAddress({ street: 'x'.repeat(200), city: 'Newark', state: 'DE', zip: '19711' })).toBeNull();
  });

  it('writes a prep-note line for what was applied', () => {
    const r = result();
    const f = roofFigures(r, { overhangIn: 12, excluded: [5] });
    expect(noteLine(r, f, 'floor')).toBe('• Satellite (Google, Jun 2023): attic floor about 1,970 sq ft with a 12-inch overhang; roof surface about 2,560 sq ft at 6/12.');
    expect(noteLine(r, f, 'roof')).toBe('• Satellite (Google, Jun 2023): roof surface about 2,560 sq ft at 6/12; attic floor about 1,970 sq ft with a 12-inch overhang.');
    expect(noteLine(r, f, 'walls')).toBe('• Satellite (Google, Jun 2023): wall run about 220 ft with a 12-inch overhang; footprint about 2,340 sq ft.');
    expect(noteLine(r, roofFigures(r, { overhangIn: 18, excluded: [3, 4, 5] }), 'floor')).toBe('• Satellite (Google, Jun 2023): attic floor about 1,370 sq ft with an 18-inch overhang; roof surface about 2,560 sq ft at 6/12.');
    expect(noteLine(r, roofFigures(r, { overhangIn: 6, excluded: [5] }), 'walls')).toMatch(/wall run about 224 ft with a 6-inch overhang/);
    const none = roofFigures({ ...r, imagery: null }, { overhangIn: 0, excluded: [] });
    expect(noteLine({ ...r, imagery: null }, none, 'floor')).toBe('• Satellite (Google): attic floor about 2,340 sq ft with no overhang; roof surface about 2,560 sq ft at 6/12.');
  });
});

describe('mergeNotes', () => {
  const line = '• Satellite (Google, Jun 2023): attic floor about 1,970 sq ft with a 12-inch overhang; roof surface about 2,560 sq ft at 6/12.';
  const later = '• Satellite (Google, Jun 2023): attic floor about 1,370 sq ft with an 18-inch overhang; roof surface about 2,560 sq ft at 6/12.';

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
    expect(roofRequestSchema.parse(ok).address).toBe('12 Elkton Rd, Newark, DE 19711');
    expect(roofRequestSchema.safeParse({ ...ok, address: '12' }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ ...ok, address: 'x'.repeat(201) }).success).toBe(false);
    expect(roofRequestSchema.safeParse({ ...ok, areaId: 'nope' }).success).toBe(false);
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
