import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/takeoff.json';
import { compactTakeoff, defaultFaces, EDGE_TYPES, FT_PER_M, takeoffSchema, type RoofChoices, type RoofResult } from './lookup';
import {
  atticFloorNote,
  clampWaste,
  DEFAULT_WASTE,
  EDGE_INFO,
  edgeFeet,
  edgesMeasured,
  EDGES_NOT_MEASURED,
  lowSlopeSqft,
  materials,
  NO_SHINGLES,
  oneDecimal,
  orderFor,
  OUTLINE_COLOR,
  photoText,
  presentEdges,
  REPORT_FOOTER,
  reportFaceColumns,
  reportFileTitle,
  roofingSquares,
  roofSurfaceSqft,
  shingleSqft,
  summaryText,
  takeoffData,
  tappedTitle,
  WASTE_CHOICES,
} from './roofing';

/** Roof Takeoff's own answer for its cross-gable mock house (an L-shaped 6/12 roof with a porch). */
const house = (name: string): RoofResult => compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'roof-takeoff', `${name}.json`), 'utf8'))));
const crossGable = () => house('3-cross-gable');
const elkton = (): RoofResult => compactTakeoff(takeoffSchema.parse(structuredClone(fixture)));
const choices = (overhangIn: number, excluded: number[], unmatchedOut = false): RoofChoices => ({ overhangIn, excluded, unmatchedOut });
const noon = new Date(2026, 10, 17, 12, 5);
const roundSqftTo10 = (n: number) => Math.round(n / 10) * 10;

describe('edge colours', () => {
  it('has one colour and a plain description for every edge type, as on the Roof Takeoff page', () => {
    expect(Object.keys(EDGE_INFO)).toEqual([...EDGE_TYPES]);
    expect(EDGE_INFO.ridge.color).toBe('#FF5A5A');
    expect(EDGE_INFO.hip.color).toBe('#FFC21A');
    expect(EDGE_INFO.valley.color).toBe('#3FA9FF');
    expect(EDGE_INFO.eave.color).toBe('#4CD07D');
    expect(EDGE_INFO.rake.color).toBe('#FF7AD0');
    expect(EDGE_INFO.step.color).toBe('#B794FF');
    expect(EDGE_INFO.headwall.color).toBe('#4FE3E3');
    expect(EDGE_INFO.break).toMatchObject({ label: 'Pitch break', color: '#FFFFFF', dash: [7, 5] });
    const colors = EDGE_TYPES.filter((k) => k !== 'break').map((k) => EDGE_INFO[k].color);
    expect(new Set(colors).size).toBe(colors.length);
    expect(colors).not.toContain(OUTLINE_COLOR);
    for (const k of EDGE_TYPES) expect(EDGE_INFO[k].what).toMatch(/^[A-Z][a-z ,]+$/);
  });
});

describe('edge feet and materials', () => {
  it('turns each total into feet along the slope', () => {
    const ft = edgeFeet(crossGable());
    expect(ft.ridge).toBeCloseTo(24.398 * FT_PER_M, 9);
    expect(ft.eave).toBeCloseTo(136.02, 2);
    expect(ft.hip).toBe(0);
    expect(presentEdges(ft)).toEqual(['ridge', 'valley', 'eave', 'rake', 'headwall']);
  });

  it('a missing total is 0', () => {
    const ft = edgeFeet({ edgeTotalsM: { ridge: 10 } as RoofResult['edgeTotalsM'] });
    expect(ft.ridge).toBeCloseTo(32.8084, 9);
    expect(ft.valley).toBe(0);
    expect(Object.keys(ft)).toEqual([...EDGE_TYPES]);
  });

  it('works out the materials, each rounded up to the next foot', () => {
    expect(materials(edgeFeet(crossGable()))).toEqual([
      { item: 'Drip edge', from: 'Eaves + rakes', ft: 238 }, // 136.02 + 101.20 = 237.22
      { item: 'Starter strip', from: 'Eaves', ft: 137 },
      { item: 'Ridge cap', from: 'Ridges + hips', ft: 81 },
      { item: 'Valley (ice and water, flashing)', from: 'Valleys', ft: 31 },
      { item: 'Headwall (apron) flashing', from: 'Headwalls', ft: 16 },
    ]);
  });

  it('adds hips to the ridge cap and steps to their own flashing', () => {
    const ft = { ridge: 20, hip: 30.2, valley: 0, eave: 100, rake: 0, step: 12, headwall: 0, break: 8 };
    expect(materials(ft)).toEqual([
      { item: 'Drip edge', from: 'Eaves + rakes', ft: 100 },
      { item: 'Starter strip', from: 'Eaves', ft: 100 },
      { item: 'Ridge cap', from: 'Ridges + hips', ft: 51 },
      { item: 'Step flashing', from: 'Steps', ft: 12 },
    ]);
  });

  it('a roof with no shingle area gets no starter strip or ridge cap', () => {
    const ft = { ridge: 20, hip: 0, valley: 0, eave: 100, rake: 30, step: 0, headwall: 12, break: 0 };
    expect(materials(ft, false)).toEqual([
      { item: 'Drip edge', from: 'Eaves + rakes', ft: 130 },
      { item: 'Headwall (apron) flashing', from: 'Headwalls', ft: 12 },
    ]);
  });

  it('does not round a whole foot up to the next one', () => {
    const ft = { ridge: 40.0000000001, hip: 0, valley: 0, eave: 0, rake: 0, step: 0, headwall: 0, break: 0 };
    expect(materials(ft)).toEqual([{ item: 'Ridge cap', from: 'Ridges + hips', ft: 40 }]);
  });

  it('says when the edges were not measured', () => {
    const r = crossGable();
    expect(edgesMeasured(r)).toBe(true);
    const none = { ...r, edges: [], edgeTotalsM: Object.fromEntries(EDGE_TYPES.map((k) => [k, 0])) as RoofResult['edgeTotalsM'] };
    expect(edgesMeasured(none)).toBe(false);
    expect(materials(edgeFeet(none))).toEqual([]);
  });
});

describe('squares, waste and the order', () => {
  it('a square is 100 sq ft of roof surface', () => {
    expect(roofingSquares(2140.94)).toBeCloseTo(21.4094, 9);
    expect(oneDecimal(roofingSquares(2140.94))).toBe('21.4');
    expect(oneDecimal(20)).toBe('20.0');
  });

  it('the roof surface is every face along the slope, or nothing without faces', () => {
    expect(roofSurfaceSqft(crossGable())).toBeCloseTo(198.9 * 10.7639, 6);
    expect(roofSurfaceSqft({ segments: [] })).toBeNull();
  });

  it('keeps faces under 2/12 out of the shingle area', () => {
    const r = crossGable(); // face 5 is a 1/12 porch roof
    expect(lowSlopeSqft(r)).toBeCloseTo(128.41, 1);
    expect(shingleSqft(r)! + lowSlopeSqft(r)).toBeCloseTo(roofSurfaceSqft(r)!, 6);
    expect(lowSlopeSqft(house('1-gable'))).toBe(0);
    expect(shingleSqft(house('6-flat'))).toBe(0);
    expect(shingleSqft({ segments: [] })).toBeNull();
  });

  it('offers gable, hip and cut-up waste, and keeps a typed waste within 0 to 50', () => {
    expect(WASTE_CHOICES.map((w) => [w.pct, w.label])).toEqual([[10, 'Gable 10%'], [15, 'Hip 15%'], [20, 'Cut-up 20%']]);
    expect(DEFAULT_WASTE).toBe(15);
    expect(clampWaste(12.5)).toBe(12.5);
    expect(clampWaste(-3)).toBe(0);
    expect(clampWaste(80)).toBe(50);
    expect(clampWaste(Number.NaN)).toBe(15);
  });

  it('orders in bundles at 3 per square, rounded up to the next bundle, as the Roof Takeoff page did', () => {
    const sqft = 198.9 * 10.7639; // 2,140.9 sq ft
    expect(orderFor(sqft, 15)).toEqual({ bundles: 74, squares: 74 / 3, text: '24⅔' }); // 21.41 × 1.15 × 3 = 73.9
    expect(orderFor(sqft, 10)).toMatchObject({ bundles: 71, text: '23⅔' });
    expect(orderFor(sqft, 20)).toMatchObject({ bundles: 78, text: '26' });
    expect(orderFor(sqft, 0)).toMatchObject({ bundles: 65, text: '21⅔' });
    expect(orderFor(sqft, 50)).toMatchObject({ bundles: 97, text: '32⅓' });
    expect(orderFor(sqft, 99)).toEqual(orderFor(sqft, 50));
  });

  it('an exact number of bundles is not rounded up again', () => {
    expect(orderFor(1000, 20)).toMatchObject({ bundles: 36, text: '12' }); // 10 × 1.2 × 3 = 36.000000000000004
    expect(orderFor(100, 0)).toMatchObject({ bundles: 3, text: '1' });
    expect(orderFor(0, 15)).toEqual({ bundles: 0, squares: 0, text: '0' });
  });
});

describe('the report and the summary', () => {
  it('describes the photo', () => {
    expect(photoText({ quality: 'HIGH', imagery: { year: 2024, month: 5 } })).toBe('High-detail aerial photo from May 2024');
    expect(photoText({ quality: 'LOW', imagery: null })).toBe('Lower-detail aerial photo, date unknown');
    expect(photoText({ quality: null, imagery: { year: 2023, month: 6 } })).toBe('Aerial photo from Jun 2023');
  });

  it('says how the attic floor was worked out', () => {
    const r = elkton();
    expect(atticFloorNote(r, choices(12, [5]))).toBe('Roof outline minus a 12" overhang all the way around, without face 5.');
    expect(atticFloorNote(r, choices(0, [3, 4, 5]))).toBe('Roof outline, no overhang removed, without faces 3, 4 and 5.');
    expect(atticFloorNote({ ...r, sharedWallM: 10 }, choices(12, []))).toBe('Roof outline minus a 12" overhang all the way around, except along the 33 ft shared wall.');
    expect(atticFloorNote({ ...r, perimeterSource: 'box' }, choices(18, []))).toBe("Google's building size minus a 18\" overhang, with the roof edge estimated from the building's shape.");
    expect(atticFloorNote({ ...r, perimeterSource: 'none' }, choices(12, []))).toBe("Google's building size. No overhang removed: the length of the roof edge isn't known.");
    expect(atticFloorNote({ ...r, footprintM2: 242, unmatchedM2: 25 }, choices(12, [5], true))).toBe('Roof outline minus a 12" overhang all the way around, without face 5 and the parts with no roof data.');
  });

  it('gathers everything the report shows', () => {
    const d = takeoffData(crossGable(), choices(12, [5]), 15, noon);
    expect(d.title).toBe('3 Cross Gable Ct, Newark, DE 19711, USA');
    expect(d.lookedUp).toBe('Nov 17, 2026, 12:05 PM');
    expect(d.photo).toBe('High-detail aerial photo from May 2024');
    expect(Math.round(d.atticFloorSqft / 10) * 10).toBe(1610);
    expect(Math.round(d.deckSqft! / 10) * 10).toBe(1800);
    expect(Math.round(d.wallRunFt!)).toBe(171);
    // Squares and the order leave out the 1/12 porch roof (128 sq ft): no shingles on it.
    expect(roundSqftTo10(d.roofSqft!)).toBe(2140);
    expect(roundSqftTo10(d.lowSlopeSqft)).toBe(130);
    expect(d.squares).toBeCloseTo(20.125, 3);
    expect(d.order).toMatchObject({ bundles: 70, text: '23⅓' }); // 20.13 × 1.15 × 3 = 69.4
    expect(d.mainPitch).toBe(6);
    expect(d.faces.map((f) => [f.n, f.pitch, f.lowSlope, f.direction, f.overAttic])).toEqual([
      [1, '6/12', false, 'faces north', true],
      [2, '6/12', false, 'faces south', true],
      [3, '6/12', false, 'faces west', true],
      [4, '6/12', false, 'faces east', true],
      [5, '1/12', true, 'faces south', false],
    ]);
    expect(d.edges.map((e) => e.label)).toEqual(['Ridge', 'Valley', 'Eave', 'Rake', 'Headwall']);
    expect(d.materials.map((m) => m.ft)).toEqual([238, 137, 81, 31, 16]);
    expect(d.warnings).toEqual([]);
  });

  it('a house with no roof faces has no roof surface or order', () => {
    const r = { ...crossGable(), segments: [], faces: [] };
    const d = takeoffData(r, choices(12, []), 15, noon);
    expect([d.roofSqft, d.squares, d.order, d.mainPitch, d.lowSlopeSqft]).toEqual([null, null, null, null, 0]);
    expect(summaryText(d)).toContain('Roof surface: –');
    expect(summaryText(d)).not.toContain('Squares');
    expect(summaryText(d)).not.toContain(NO_SHINGLES);
  });

  it('a flat roof is not ordered as shingles', () => {
    for (const name of ['6-flat', '8-main-row']) {
      const r = house(name);
      const d = takeoffData(r, { overhangIn: 12, ...defaultFaces(r, 'house') }, 15, noon);
      expect(d.squares, name).toBeNull();
      expect(d.order, name).toBeNull();
      expect(d.lowSlopeSqft, name).toBeCloseTo(d.roofSqft!, 6);
      expect(d.mainPitch, name).toBe(0.3);
      expect(d.materials.map((m) => m.item), name).not.toContain('Ridge cap');
      expect(d.materials.map((m) => m.item), name).not.toContain('Starter strip');
      const text = summaryText(d);
      expect(text).toContain(NO_SHINGLES);
      expect(text).toContain('Main pitch: 0.3/12');
      expect(text).not.toMatch(/bundle|Squares/);
    }
    const row = takeoffData(house('8-main-row'), choices(12, []), 15, noon);
    expect(row.materials).toEqual([{ item: 'Drip edge', from: 'Eaves + rakes', ft: 52 }]);
    expect(summaryText(row)).toContain('Low-slope roof (under 2/12, not shingles): 2,400 sq ft');
  });

  it('keeps the low-slope faces of a cape out of the order', () => {
    const r = house('7-cape'); // faces 2 (1.5/12) and 6 (1/12)
    const d = takeoffData(r, { overhangIn: 12, ...defaultFaces(r, 'house') }, 15, noon);
    expect(d.faces.filter((f) => f.lowSlope).map((f) => f.n)).toEqual([2, 6]);
    expect(roundSqftTo10(d.lowSlopeSqft)).toBe(420);
    expect(d.squares).toBeCloseTo(14.72, 2);
    expect(d.order).toMatchObject({ bundles: 51, text: '17' });
    expect(summaryText(d)).toContain('Squares (2/12 and up): 14.7');
  });

  it('names a tapped roof by the house it was tapped near, and where', () => {
    const r = { ...crossGable(), address: null, precision: 'PIN', point: { lat: 39.683471234, lng: -75.750391 } };
    expect(tappedTitle(r.point, '12 Elkton Rd, Newark, DE 19711')).toBe('Roof tapped near 12 Elkton Rd, Newark, DE 19711 (39.68347, -75.75039)');
    expect(tappedTitle(r.point, null)).toBe('Roof tapped at 39.68347, -75.75039');
    expect(takeoffData(r, choices(12, [5]), 15, noon, { near: '12 Elkton Rd, Newark, DE 19711' }).title).toBe('Roof tapped near 12 Elkton Rd, Newark, DE 19711 (39.68347, -75.75039)');
    expect(takeoffData(r, choices(12, [5]), 15, noon).title).toBe('Roof tapped at 39.68347, -75.75039');
    expect(takeoffData(crossGable(), choices(12, [5]), 15, noon, { near: 'x' }).title).toBe('3 Cross Gable Ct, Newark, DE 19711, USA');
  });

  it('puts a long list of faces side by side on the report', () => {
    expect([1, 12, 13, 26, 27, 60].map(reportFaceColumns)).toEqual([1, 1, 2, 2, 3, 3]);
  });

  it('names the saved PDF after the house', () => {
    expect(reportFileTitle(takeoffData(crossGable(), choices(12, [5]), 15, noon))).toBe('Roof takeoff - 3 Cross Gable Ct, Newark, DE 19711, USA');
  });

  it("heads the summary with the store's name, or just the title when there is none", () => {
    expect(summaryText(takeoffData(crossGable(), choices(12, [5]), 15, noon, { company: ' Koala Insulation of Dover ' })).split('\n')[0]).toBe(
      'Koala Insulation of Dover: roof takeoff',
    );
    expect(summaryText(takeoffData(crossGable(), choices(12, [5]), 15, noon)).split('\n')[0]).toBe('Roof takeoff');
  });

  it('writes a plain-text summary to paste into a note, text or email', () => {
    const text = summaryText(takeoffData(crossGable(), choices(12, [5]), 15, noon, { company: 'Koala Insulation of Newark' }));
    expect(text.split('\n')).toEqual([
      'Koala Insulation of Newark: roof takeoff',
      '3 Cross Gable Ct, Newark, DE 19711, USA',
      'Looked up Nov 17, 2026, 12:05 PM. High-detail aerial photo from May 2024.',
      '',
      'Attic floor: 1,610 sq ft (Roof outline minus a 12" overhang all the way around, without face 5)',
      'Roof deck over the attic (spray foam): 1,800 sq ft',
      'Footprint: 1,930 sq ft (roof outline seen from above, to the drip edge)',
      'Wall run: 171 ft',
      'Roof surface: 2,140 sq ft',
      'Low-slope roof (under 2/12, not shingles): 130 sq ft',
      'Squares (2/12 and up): 20.1',
      'Order with 15% waste: 23⅓ squares (70 bundles)',
      'Main pitch: 6/12',
      'Overhang used: 12"',
      '',
      'Roof faces:',
      '  1. 6/12, faces north, 780 sq ft, over the attic',
      '  2. 6/12, faces south, 670 sq ft, over the attic',
      '  3. 6/12, faces west, 280 sq ft, over the attic',
      '  4. 6/12, faces east, 280 sq ft, over the attic',
      '  5. 1/12 (low slope), faces south, 130 sq ft, not over the attic',
      '',
      'Roof edges (feet along the slope): ridge 80, valley 30, eave 136, rake 101, headwall 16',
      'Materials (rounded up; estimates from aerial data, check on site): drip edge 238 ft, starter strip 137 ft, ridge cap 81 ft, valley (ice and water, flashing) 31 ft, headwall (apron) flashing 16 ft',
      '',
      REPORT_FOOTER,
    ]);
    expect(REPORT_FOOTER).toBe('Estimates from Google aerial imagery. Verify on site.');
  });

  it('lists the warnings and says when the edges were not measured', () => {
    const r = elkton();
    const none = { ...r, edges: [], edgeTotalsM: Object.fromEntries(EDGE_TYPES.map((k) => [k, 0])) as RoofResult['edgeTotalsM'] };
    const text = summaryText(takeoffData(none, choices(0, []), 10, noon));
    expect(text).toContain(EDGES_NOT_MEASURED);
    expect(text).toContain('Check on site:\n  - Lower-detail imagery. Check the pitch on site.');
    expect(text).toContain('Overhang used: none');
    expect(text).toContain('Order with 10% waste:');
    expect(text).not.toContain('Materials');
  });

  it("can carry the app's own check-on-site list instead of Roof Takeoff's warnings", () => {
    const d = takeoffData(elkton(), choices(12, [5]), 15, noon, { warnings: ['Check the white outline is on the roof you tapped.'] });
    expect(d.warnings).toEqual(['Check the white outline is on the roof you tapped.']);
    expect(takeoffData(elkton(), choices(12, [5]), 15, noon).warnings).toEqual(['Lower-detail imagery. Check the pitch on site.']);
  });
});
