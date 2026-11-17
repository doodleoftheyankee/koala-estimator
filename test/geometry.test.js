// Geometry of lib/takeoff.js on in-memory synthetic rasters (dev/houses.js holds the analytic truth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUSES, HOUSE_SPECS, makeHouse, insightsFor, renderLayers, FT, GROUND_ELEV } from '../dev/houses.js';
import { encodeGeoTiff } from '../dev/tiff.js';
import { trimInsights } from '../lib/google.js';
import { readGeoTiff } from '../lib/raster.js';
import {
  measureRoof, atticFloor, faceDefaults, planeHeightOf, layerSize, riseOf, utm, utmInverse, zoneOfLatLng, latLngFrame,
  offsetPoly, roofOutline, untracedFaces, EDGE_TYPES,
} from '../lib/takeoff.js';

const F2 = FT * FT;
const [GABLE, HIP, CROSS, , TWIN, FLAT, CAPE] = HOUSES;

function setup(house, opts = {}) {
  const t = trimInsights(insightsFor(house));
  const segments = t.segments.map(s => ({ ...s, rise: riseOf(s.pitchDeg), lowSlope: riseOf(s.pitchDeg) < 2 }));
  const rasters = renderLayers(house.lat, house.lng, { radius: 25, pixel: 0.1, layers: ['mask', 'dsm'], house, noise: 0.03, ...opts });
  return { building: t.building, segments, ...rasters };
}

// The server's whole path (api/takeoff.js minus the I/O): cut at Google's box, default face choices, attic floor.
function measure(house, opts) {
  const s = setup(house, opts);
  const m = measureRoof({ segments: s.segments, center: s.building.center, box: s.building.box, mask: s.mask, dsm: s.dsm });
  const choice = faceDefaults(s.segments, planeHeightOf(s.segments, m.planeHeights));
  const attic = atticFloor({
    building: s.building, segments: s.segments, outline: m.outline, overhangM: FT,
    sharedWallM: m.sharedWallM, excluded: choice.excluded, perimeterByFaceM: m.perimeterByFaceM,
  });
  return { ...s, ...m, attic, choice };
}

// The house's own name for a Solar face (matched by ground area, pitch and direction).
function nameOf(house, seg) {
  const f = house.faces.filter(x => x.solar).find(x => {
    const g = Math.abs(x.poly.reduce((t, a, i) => { const b = x.poly[(i + 1) % x.poly.length]; return t + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
    const da = Math.abs(((x.azDeg - seg.azimuthDeg) % 360 + 540) % 360 - 180);
    return Math.abs(g - seg.groundM2) < 0.5 && Math.abs(x.rise - riseOf(seg.pitchDeg)) < 0.2 && da < 5;
  });
  return f ? f.name : null;
}
const byName = (house, m) => Object.fromEntries(m.segments.map(s => [nameOf(house, s), s]));

function near(got, want, frac, label) {
  assert.ok(Math.abs(got - want) <= frac * Math.abs(want), `${label}: got ${got.toFixed(3)}, want ${want.toFixed(3)} (within ${frac * 100}%)`);
}

const totalsFt = m => Object.fromEntries(EDGE_TYPES.map(k => [k, m.edgeTotalsM[k] / FT]));

test('UTM inverse is the exact inverse of the forward series across a zone and in the south', () => {
  let worst = 0;
  for (let lat = -60; lat <= 70; lat += 10) {
    for (const lng of [-80.9, -78.3, -75.75, -73.1, -72.05, 151.2]) {
      const z = zoneOfLatLng(lat, lng), p = utm(lat, lng, z), q = utmInverse(p.x, p.y, z), p2 = utm(q.lat, q.lng, z);
      worst = Math.max(worst, Math.hypot(p2.x - p.x, p2.y - p.y));
      assert.ok(Math.abs(q.lat - lat) < 1e-9 && Math.abs(q.lng - lng) < 1e-9, `lat/lng back for ${lat},${lng}`);
    }
  }
  assert.ok(worst < 1e-6, `round trip error ${worst} m`);
  // Newark, DE is in zone 18 north (EPSG 32618).
  assert.deepEqual(zoneOfLatLng(39.68, -75.75), { zone: 18, south: false });
});

test('pixel <-> lat/lng frame round trip on a raster', () => {
  const { mask } = setup(GABLE);
  const f = latLngFrame(mask);
  for (const [u, v] of [[0, 0], [123.4, 56.7], [mask.w, mask.h]]) {
    const p = f.toLatLng(u, v), [u2, v2] = f.toPx(p.lat, p.lng);
    assert.ok(Math.abs(u2 - u) < 1e-6 && Math.abs(v2 - v) < 1e-6);
  }
});

test('offsetPoly pushes the outline outward', () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const area = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
  assert.equal(Math.round(area(offsetPoly(sq, 0.5))), 121);
  assert.equal(Math.round(area(offsetPoly(sq.slice().reverse(), 0.5))), 121);
});

test('attic floor formula is exact on a 40 x 30 ft rectangle with a 1 ft overhang', () => {
  const outline = { areaM2: 1200 * F2, perimeterM: 140 * FT };
  const a = atticFloor({ building: {}, segments: [], outline, overhangM: FT });
  near(a.floorM2, 38 * 28 * F2, 1e-4, 'floor');
  assert.equal(a.perimeterSource, 'outline');
  near(a.wallRunM, (140 - 8) * FT, 1e-4, 'wall run');
  assert.deepEqual(Object.keys(a), ['overhangM', 'footprintM2', 'perimeterM', 'perimeterSource', 'sharedWallM', 'unmatchedM2',
    'perimeterByFaceM', 'excluded', 'excludedM2', 'floorM2', 'wallRunM', 'deckM2']);
  assert.equal(a.deckM2, null, 'no faces: no roof deck');
  // Low-slope faces come out by their ground area.
  const segs = [{ n: 1, groundM2: 1000 * F2, lowSlope: false }, { n: 2, groundM2: 200 * F2, lowSlope: true }];
  const b = atticFloor({ building: {}, segments: segs, outline, overhangM: FT });
  assert.deepEqual(b.excluded, [2]);
  near(b.floorM2, 1064 * F2 * (1 - 200 / 1200), 1e-3, 'floor without the porch');
  // No outline: the box's aspect ratio scaled to Google's footprint gives the same perimeter for a rectangle.
  const box = { sw: GABLE.frame.toLatLng(-20 * FT, -15 * FT), ne: GABLE.frame.toLatLng(20 * FT, 15 * FT) };
  const c = atticFloor({ building: { box, whole: { groundM2: 1200 * F2 } }, segments: [], outline: null, overhangM: FT });
  assert.equal(c.perimeterSource, 'box');
  near(c.perimeterM, 140 * FT, 0.002, 'box perimeter');
  near(c.floorM2, 1064 * F2, 0.002, 'box floor');
  const d = atticFloor({ building: { faces: { groundM2: 100 } }, segments: [], outline: null, overhangM: 0.3 });
  assert.equal(d.perimeterSource, 'none');
  assert.equal(d.footprintM2, 100);
});

test('gable: outline, faces, ridge, eaves and rakes match the drawing', () => {
  const m = measure(GABLE);
  assert.equal(m.outline.polys.length, 1, 'the shed next door is not part of the building');
  near(m.outline.areaM2 / F2, 1200, 0.02, 'outline area');
  near(m.outline.perimeterM / FT, 140, 0.02, 'outline perimeter');
  assert.equal(m.faces.length, 2);
  for (const f of m.faces) near(f.planM2 / F2, 600, 0.03, `face ${f.n} plan area`);
  const t = totalsFt(m);
  near(t.ridge, 40, 0.05, 'ridge');
  near(t.eave, 80, 0.05, 'eaves');
  near(t.rake, 4 * 15 * Math.sqrt(1.25), 0.05, 'rakes');
  for (const k of ['hip', 'valley', 'step', 'break']) assert.ok(t[k] < 1.5, `${k} should be about 0, got ${t[k]}`);
  assert.equal(m.edges.filter(e => e.type === 'ridge').length, 1);
  assert.equal(m.edges.filter(e => e.type === 'rake').length, 4);
  near(m.attic.floorM2 / F2, 1064, 0.02, 'attic floor');
  assert.deepEqual(Object.keys(m.edgeTotalsM).sort(), [...EDGE_TYPES].sort());
  for (const e of m.edges) assert.ok(e.path.length === 2 && e.lengthM >= e.planM - 1e-9);
});

test('hip: ridge, four hips and eaves match the drawing (house turned 25 degrees)', () => {
  const m = measure(HIP);
  near(m.outline.areaM2 / F2, 1500, 0.02, 'outline area');
  assert.equal(m.faces.length, 4);
  const t = totalsFt(m);
  near(t.ridge, 20, 0.05, 'ridge');
  near(t.hip, 4 * Math.hypot(15, 15) * Math.sqrt(1.125), 0.05, 'hips (true length)');
  near(t.eave, 160, 0.05, 'eaves');
  for (const k of ['rake', 'valley', 'step', 'break']) assert.ok(t[k] < 1.5, `${k} should be about 0, got ${t[k]}`);
  const hips = m.edges.filter(e => e.type === 'hip');
  assert.equal(hips.length, 4);
  for (const h of hips) {
    near(h.planM / FT, Math.hypot(15, 15), 0.06, 'hip plan');
    near(h.lengthM / h.planM, Math.sqrt(1.125), 0.01, 'hip slope factor');
  }
  near(m.attic.floorM2 / F2, 1344, 0.02, 'attic floor');
});

test('cross gable: valleys, porch wall headwall, porch left out of the attic, chimney ignored', () => {
  const m = measure(CROSS);
  near(m.outline.areaM2 / F2, 1928, 0.02, 'outline area');
  near(m.outline.perimeterM / FT, 212, 0.02, 'outline perimeter');
  const t = totalsFt(m), truth = CROSS.truth.ft;
  near(t.valley, truth.valley, 0.05, 'valleys');
  assert.equal(m.edges.filter(e => e.type === 'valley').length, 2);
  near(t.ridge, truth.ridge, 0.05, 'ridges');
  near(t.rake, truth.rake, 0.05, 'rakes');
  near(t.eave, truth.eave, 0.05, 'eaves, the main eave over the porch included');
  assert.ok(t.hip < 1.5 && t.break < 1.5 && t.step < 1.5, `no hips, breaks or steps: ${t.hip}, ${t.break}, ${t.step}`);
  const porch = m.segments.find(s => s.lowSlope), front = byName(CROSS, m).front;
  assert.ok(porch, 'the porch is low slope');
  assert.equal(porch.rise, 1);
  // The porch's level top edge meets the house wall: a headwall (apron flashing), the length of the porch.
  const heads = m.edges.filter(e => e.type === 'headwall');
  assert.equal(heads.length, 1);
  assert.deepEqual(heads[0].faces, [front.n, porch.n].sort((a, b) => a - b));
  near(heads[0].planM / FT, 16, 0.05, 'porch wall');
  near(heads[0].lengthM / heads[0].planM, 1, 0.01, 'a headwall is level');
  // The higher face keeps its eave along the porch: the front face's eave is its whole 27 + 3 ft.
  const frontEave = m.edges.filter(e => e.type === 'eave' && e.faces.length === 1 && e.faces[0] === front.n).reduce((a, e) => a + e.planM, 0);
  near(frontEave / FT, 30, 0.05, 'front eave over the porch still counts');
  assert.equal(m.segments.find(s => s.n === porch.n) && m.choice.lower.has(porch.n), true, 'the porch is a lower roof');
  // The chimney sits on the back face: the face still comes out whole and adds no edges.
  const back = m.faces.find(f => f.n === m.segments.find(s => s.groundM2 > 60 && s.azimuthDeg > 300).n);
  near(back.planM2 / F2, 700 - 6, 0.03, 'back face minus the chimney');
  assert.deepEqual(m.attic.excluded, [porch.n]);
  near(m.attic.excludedM2 / F2, 128, 0.01, 'excluded area');
  near(m.attic.floorM2 / F2, CROSS.truth.attic12Ft2, 0.02, 'attic floor');
});

test('twin: the outline is cut 0.5 m past Google\'s box, the cut is the shared wall, no edges along it', () => {
  const m = measure(TWIN), tr = TWIN.truth;
  assert.equal(m.outline.polys.length, 1);
  near(m.outline.areaM2 / F2, tr.cutOutlineFt2, 0.02, 'outline: this half plus the 0.5 m allowance');
  assert.ok(m.outline.areaM2 / F2 < 1.1 * tr.outlineFt2, 'nowhere near the whole twin (1584 sq ft)');
  near(m.sharedWallM / FT, tr.sharedWallFt, 0.03, 'shared wall');
  near(m.outline.perimeterM / FT, 2 * (22 + 0.5 / FT) + 36 + 36, 0.02, 'perimeter, the cut included');
  // Without the box it would take the whole twin.
  const s = setup(TWIN), whole = measureRoof({ segments: s.segments, center: s.building.center, mask: s.mask, dsm: null });
  near(whole.outline.areaM2 / F2, 2 * 792, 0.02, 'uncut: both halves');
  assert.equal(whole.sharedWallM, 0);
  // Edges: rakes only at the free west end; nothing along the party wall; eaves and ridge stop at the cut.
  const t = totalsFt(m);
  near(t.rake, tr.ft.rake, 0.04, 'rakes (west gable only)');
  near(t.eave, 2 * (22 + 0.5 / FT), 0.04, 'eaves to the cut');
  near(t.ridge, 22 + 0.5 / FT, 0.05, 'ridge to the cut');
  for (const k of ['hip', 'valley', 'step', 'headwall', 'break']) assert.ok(t[k] < 1, `${k}: ${t[k]}`);
  assert.equal(m.edges.filter(e => e.type === 'rake').length, 2);
  // The cut doesn't count as each face's outline length either (eave + west rake only).
  for (const n of [1, 2]) near(m.perimeterByFaceM[n] / FT, 18 + 22 + 0.5 / FT, 0.04, `face ${n} outline length`);
  // Attic: the CONTRACT formula with S, no overhang taken off along the party wall.
  const A = m.outline.areaM2, P = m.outline.perimeterM, S = m.sharedWallM, d = FT;
  near(m.attic.floorM2, A - (P - S) * d + 4 * d * d, 1e-4, 'floor formula with the shared wall');
  near(m.attic.floorM2 / F2, tr.cutAttic12Ft2, 0.02, 'attic floor');
  near(m.attic.wallRunM, P - S - 8 * d, 1e-4, 'wall run leaves out the party wall');
  assert.equal(m.attic.sharedWallM, Math.round(S * 1000) / 1000);
});

test('roofOutline: a cut at the box, scraps of the neighbour dropped, small holes filled, courtyards outlined', () => {
  // 20 x 10 px roof joined to a neighbour (x 20..39) by a full-height seam, with a 1 px speck hole.
  const w = 50, h = 20, m = new Uint8Array(w * h);
  for (let y = 5; y < 15; y++) for (let x = 0; x < 40; x++) m[y * w + x] = 1;
  m[8 * w + 5] = 0;
  const o = roofOutline(m, w, h, [{ x: 5, y: 10 }], { x: 5, y: 10 }, 10, 1.2, { clip: { u0: 0, u1: 19, v0: 0, v1: 19 }, minHole: 4 });
  assert.equal(o.count, 200, 'the speck hole is filled');
  assert.equal(o.cutX, 10, 'ten pixel sides along the cut');
  assert.equal(o.cutY, 0);
  assert.ok(o.isCut(10 * w + 25) && !o.isSel(10 * w + 25) && o.isSel(10 * w + 19));
  assert.equal(o.polys.length, 1);
  // A ring with a 6 x 6 px courtyard: the courtyard is a second ring and stays out of the area.
  const r = new Uint8Array(w * h);
  for (let y = 2; y < 18; y++) for (let x = 2; x < 18; x++) r[y * w + x] = (x >= 7 && x < 13 && y >= 7 && y < 13) ? 0 : 1;
  const o2 = roofOutline(r, w, h, [{ x: 3, y: 3 }], { x: 3, y: 3 }, 10, 1.2, { minHole: 4 });
  assert.equal(o2.count, 16 * 16 - 36);
  assert.equal(o2.polys.length, 2);
  assert.equal(o2.holes, 1);
  const len = p => p.reduce((t, a, i) => { const b = p[(i + 1) % p.length]; return t + Math.hypot(b[0] - a[0], b[1] - a[1]); }, 0);
  near(len(o2.polys[0]), 64, 0.02, 'outer ring');
  near(len(o2.polys[1]), 24, 0.02, 'courtyard ring');
  // A box that misses the roof altogether doesn't lose the roof.
  const o3 = roofOutline(m, w, h, [{ x: 5, y: 10 }], { x: 5, y: 10 }, 10, 1.2, { clip: { u0: 45, u1: 49, v0: 0, v1: 3 } });
  assert.equal(o3.count, 399);
  assert.equal(o3.cutX + o3.cutY, 0);
});

test('courtyard building: the courtyard edge counts in the perimeter and the attic floor', () => {
  // 60 x 60 ft around a 24 x 24 ft courtyard, four 6/12 faces draining outward.
  const court = makeHouse({
    id: 'court', lat: 39.69, lng: -75.77, rotDeg: 0, quality: 'HIGH', faces: [
      { name: 's', poly: [[-30, -30], [30, -30], [12, -12], [-12, -12]], rise: 6, az: 180, ref: [0, -30], zRef: 3 },
      { name: 'n', poly: [[-30, 30], [-12, 12], [12, 12], [30, 30]], rise: 6, az: 0, ref: [0, 30], zRef: 3 },
      { name: 'e', poly: [[30, -30], [30, 30], [12, 12], [12, -12]], rise: 6, az: 90, ref: [30, 0], zRef: 3 },
      { name: 'w', poly: [[-30, -30], [-12, -12], [-12, 12], [-30, 30]], rise: 6, az: 270, ref: [-30, 0], zRef: 3 },
    ],
  });
  const m = measure(court);
  assert.equal(m.outline.polys.length, 2, 'outer ring and courtyard ring');
  near(m.outline.areaM2 / F2, 3600 - 576, 0.02, 'area without the courtyard');
  near(m.outline.perimeterM / FT, 240 + 96, 0.02, 'perimeter with the courtyard');
  near(m.attic.floorM2 / F2, 3024 - 336 + 4, 0.02, 'attic floor (CONTRACT formula)');
  near(m.attic.floorM2 / F2, 58 * 58 - 26 * 26, 0.02, 'attic floor (true)');
  near(m.attic.wallRunM / FT, 336 - 8, 0.02, 'wall run includes the courtyard walls');
});

test('Cape: dormer stays in, porch out, garage marked lower but in; step, headwall and eaves at each junction', () => {
  const m = measure(CAPE), tr = CAPE.truth, f = byName(CAPE, m);
  // Default face choices (CONTRACT.md "Default face choices (v1.1)").
  assert.equal(m.choice.mostlyFlat, false);
  assert.deepEqual(m.attic.excluded, [f.porch.n], 'only the porch is left out');
  assert.ok(f.dormer.lowSlope && !m.attic.excluded.includes(f.dormer.n), 'the shed dormer (1.5/12) sits over the attic');
  assert.deepEqual([...m.choice.lower].sort(), [f['garage south'].n, f['garage north'].n, f.porch.n].sort(), 'lower roofs');
  assert.ok(!m.attic.excluded.includes(f['garage south'].n), 'the garage stays in');
  // Heights came from the surface heights, for every face.
  assert.equal(Object.keys(m.planeHeights).length, 6);
  // Outline, attic floor, outline length per face, wall run, roof deck.
  near(m.outline.areaM2 / F2, tr.outlineFt2, 0.01, 'outline');
  near(m.outline.perimeterM / FT, tr.perimeterFt, 0.015, 'perimeter');
  assert.equal(m.sharedWallM, 0, 'nothing is cut from a house on its own, even turned 12 degrees in its box');
  near(m.attic.floorM2 / F2, tr.attic12Ft2, 0.01, 'attic floor');
  near(m.attic.floorM2 / F2, 1280, 0.01, 'attic floor against the true main house plus garage');
  for (const [name, ft] of Object.entries(tr.perimeterByFaceFt)) {
    const got = (m.perimeterByFaceM[f[name].n] || 0) / FT;
    assert.ok(Math.abs(got - ft) <= Math.max(0.5, 0.03 * ft), `${name} outline length: got ${got.toFixed(1)}, want ${ft}`);
  }
  near(m.attic.wallRunM / FT, tr.wallRun12Ft, 0.02, 'wall run without the porch');
  const A = m.attic.footprintM2, P = m.attic.perimeterM, d = FT;
  near(m.attic.wallRunM, P - m.perimeterByFaceM[f.porch.n] - 8 * d, 1e-3, 'wall run formula');
  const kept = m.segments.filter(s => s.n !== f.porch.n);
  near(m.attic.deckM2, m.attic.floorM2 * kept.reduce((t, s) => t + s.areaM2, 0) / kept.reduce((t, s) => t + s.groundM2, 0), 1e-3, 'roof deck formula');
  near(m.attic.floorM2, (A - P * d + 4 * d * d) * (1 - f.porch.groundM2 / A), 1e-3, 'floor formula');
  assert.ok(m.attic.unmatchedM2 < 0.01 * A, `no parts without roof data: ${m.attic.unmatchedM2}`);
  // Edges.
  const t = totalsFt(m);
  for (const k of EDGE_TYPES) {
    if (tr.ft[k]) near(t[k], tr.ft[k], 0.04, k);
    else assert.ok(t[k] < 1, `${k}: ${t[k]}`);
  }
  const edgesOf = (type, faces) => m.edges.filter(e => e.type === type && String(e.faces) === String(faces.map(x => x.n).sort((a, b) => a - b)));
  const sum = es => es.reduce((a, e) => a + e.planM, 0) / FT;
  // Dormer cheeks: the back roof's sloped sides against the dormer walls are step flashing, full length.
  near(sum(edgesOf('step', [f.back, f.dormer])), 24, 0.04, 'cheek steps (plan)');
  for (const e of edgesOf('step', [f.back, f.dormer])) near(e.lengthM / e.planM, Math.SQRT2, 0.01, 'step along the 12/12 slope');
  // The back roof's level top under the dormer front is a headwall; the dormer keeps its eave and rakes.
  near(sum(edgesOf('headwall', [f.back, f.dormer])), 24, 0.04, 'dormer front headwall');
  near(sum(edgesOf('eave', [f.dormer])), 24, 0.04, 'dormer eave over the back roof');
  near(sum(edgesOf('rake', [f.dormer])), 24, 0.04, 'dormer rakes');
  // Garage against the house's gable wall: step for the garage, and the house keeps its rakes above it.
  near(sum([...edgesOf('step', [f['garage south'], f.front]), ...edgesOf('step', [f['garage north'], f.back])]), 20, 0.05, 'garage steps');
  near(sum(edgesOf('rake', [f.front])), 28, 0.04, 'front rakes, both gables, above the garage too');
  // Porch: headwall, and the front keeps its whole eave.
  near(sum(edgesOf('headwall', [f.front, f.porch])), 16, 0.04, 'porch headwall');
  near(sum(edgesOf('eave', [f.front])), 36, 0.03, 'front eave, over the porch too');
  // The main ridge is two pieces either side of the dormer; the dormer meets the front at the ridge.
  assert.equal(edgesOf('ridge', [f.front, f.back]).length, 2);
  near(sum(edgesOf('ridge', [f.front, f.back])), 12, 0.06, 'main ridge pieces');
  near(sum(edgesOf('ridge', [f.front, f.dormer])), 24, 0.04, 'dormer at the ridge');
});

test('flat building: nothing left out by default, mostly-flat flag, bay headwall', () => {
  const m = measure(FLAT), tr = FLAT.truth;
  assert.ok(m.segments.every(s => s.lowSlope));
  assert.equal(m.choice.mostlyFlat, true);
  assert.deepEqual(m.attic.excluded, []);
  assert.equal(m.choice.lower.size, 0, 'no steep faces: no main height to be lower than');
  near(m.outline.areaM2 / F2, tr.outlineFt2, 0.01, 'outline');
  near(m.attic.floorM2 / F2, tr.attic12Ft2, 0.01, 'attic floor: the whole building');
  const t = totalsFt(m);
  near(t.headwall, 30, 0.04, 'loading bay against the main wall');
  near(t.ridge, 80, 0.04, 'crown');
  near(t.eave + t.rake, 300 + 30, 0.03, 'drip edge all round, plus the main roof above the bay');
  // Default rule on the same faces with one steep face holding most of the ground: low faces under it go.
  const segs = [{ n: 1, groundM2: 100, lowSlope: false }, { n: 2, groundM2: 30, lowSlope: true }, { n: 3, groundM2: 20, lowSlope: true }];
  const h = { 1: 10, 2: 8.3, 3: 9.6 };
  const c = faceDefaults(segs, n => h[n]);
  assert.deepEqual(c.excluded, [2], 'more than 1 m under the main roof: out; within 1 m (a dormer): in');
  assert.deepEqual([...c.lower], [2]);
  assert.deepEqual(faceDefaults(segs, () => NaN).excluded, [2, 3], 'no heights: every low-slope face out, as in v1');
  assert.deepEqual(faceDefaults([{ n: 1, groundM2: 40, lowSlope: false }, { n: 2, groundM2: 60, lowSlope: true }], n => h[n]).excluded, []);
});

test('plane heights: a tree over a face center or a dormer on it no longer loses the face', () => {
  const hip = HOUSE_SPECS.find(h => h.id === 'hip');
  const treeAt = (over, inMask) => makeHouse({ ...hip, id: 'hip-tree', trees: [{ at: [0, -8.3], r: 4, h: 9, over, inMask }] });
  for (const inMask of [true, false]) {
    const m = measure(treeAt(true, inMask)), t = totalsFt(m);
    near(t.ridge, 20, 0.06, `ridge, tree ${inMask ? 'in' : 'not in'} the mask`);
    near(t.hip, 90, 0.05, 'hips');
    near(t.eave, 160, 0.05, 'eaves');
    const south = m.segments.find(s => s.groundM2 > 40 && Math.abs(s.azimuthDeg - 205) < 5);
    const face = m.faces.find(x => x.n === south.n);
    assert.ok(face.planM2 > 0.8 * south.groundM2, `south face found: ${(face.planM2 / F2).toFixed(0)} of ${(south.groundM2 / F2).toFixed(0)} sq ft`);
    assert.deepEqual(untracedFaces(m.segments, m.faces), []);
  }
  // A big tree over most of a small face: that face is reported as not traced (the server then warns).
  const big = measure(makeHouse({ ...hip, id: 'hip-bigtree', trees: [{ at: [20, 0], r: 10, h: 10, over: true }] }));
  const east = big.segments.find(s => Math.abs(s.azimuthDeg - 115) < 5);
  assert.deepEqual(untracedFaces(big.segments, big.faces), [east.n]);
});

test('outer sides check the outside height first: a gable end against a taller block with no face is a step', () => {
  const g = (extra) => makeHouse({
    id: 'wing', lat: 39.69, lng: -75.765, rotDeg: 8, quality: 'HIGH',
    faces: [
      { name: 'south', poly: [[-20, -15], [20, -15], [20, 0], [-20, 0]], rise: 6, az: 180, ref: [0, -15], zRef: 2.8 },
      { name: 'north', poly: [[-20, 0], [20, 0], [20, 15], [-20, 15]], rise: 6, az: 0, ref: [0, 15], zRef: 2.8 },
    ],
    ...extra,
  });
  // Two-story flat block against the west gable end, no Solar face; a tree beside the east rake.
  const m = measure(g({ flats: [{ poly: [[-40, -18], [-20, -18], [-20, 18], [-40, 18]], z: 7 }], trees: [{ at: [26, 4], r: 7, h: 9 }] }));
  const t = totalsFt(m);
  near(t.rake, 2 * 15 * Math.sqrt(1.25), 0.05, 'rakes: the free east end only');
  near(t.step, 2 * 15 * Math.sqrt(1.25), 0.05, 'step flashing along the tall wall');
  near(t.eave, 80, 0.05, 'eaves');
  near(t.ridge, 40, 0.05, 'ridge');
  // The block has no roof data: it is the unmatched part of the outline.
  near(m.attic.unmatchedM2 / F2, 20 * 36, 0.05, 'unmatched (the block)');
  // Its sides along the block are not on the outline.
  for (const s of m.segments) near(m.perimeterByFaceM[s.n] / FT, 40 + 15, 0.04, `face ${s.n} outline length`);
});

test("surface heights and Solar plane heights don't share a datum, and that's fine", () => {
  const s = setup(GABLE);
  const mid = s.dsm.data[(s.dsm.h >> 1) * s.dsm.w + (s.dsm.w >> 1)];
  assert.ok(mid - s.segments[0].heightM > GROUND_ELEV - 3, 'the DSM is meters above the Solar heights');
  const m = measureRoof({ segments: s.segments, center: s.building.center, mask: s.mask, dsm: s.dsm });
  assert.equal(m.faces.length, 2);
});

test('mask and surface heights on different grids (coarser, shifted, bigger)', () => {
  const m = measure(HIP, { dsmPixel: 0.2, dsmShift: 0.05, dsmPad: 7 });
  near(m.outline.areaM2 / F2, 1500, 0.02, 'outline area');
  const t = totalsFt(m);
  near(t.ridge, 20, 0.08, 'ridge');
  near(t.hip, 90, 0.05, 'hips');
  near(t.eave, 160, 0.05, 'eaves');
});

test('hip at 25 cm pixels (medium-detail imagery) stays within 5%', () => {
  const m = measure(HIP, { pixel: 0.25 });
  const t = totalsFt(m);
  near(t.ridge, 20, 0.05, 'ridge');
  near(t.hip, 90, 0.05, 'hips');
  near(t.eave, 160, 0.05, 'eaves');
  near(m.outline.areaM2 / F2, 1500, 0.02, 'outline area');
});

test('degrades without surface heights or mask, and falls back to the blob nearest the center', () => {
  const s = setup(GABLE);
  const noDsm = measureRoof({ segments: s.segments, center: s.building.center, mask: s.mask, dsm: null });
  assert.ok(noDsm.outline);
  assert.deepEqual([noDsm.faces, noDsm.edges], [[], []]);
  assert.deepEqual(noDsm.edgeTotalsM, Object.fromEntries(EDGE_TYPES.map(k => [k, 0])));
  const none = measureRoof({ segments: s.segments, center: s.building.center, mask: null, dsm: s.dsm });
  assert.equal(none.outline, null);
  const noSeeds = measureRoof({ segments: s.segments.map(x => ({ ...x, center: null })), center: s.building.center, mask: s.mask, dsm: null });
  near(noSeeds.outline.areaM2 / F2, 1200, 0.02, 'nearest blob');
});

test('photo size: page rules, and the color photo always fits a 4.5 MB response', () => {
  const c = { lat: 39.68, lng: -75.75 };
  const boxOf = m => ({ sw: { lat: c.lat - m / 2 / 111320, lng: c.lng - m / 2 / 85700 }, ne: { lat: c.lat + m / 2 / 111320, lng: c.lng + m / 2 / 85700 } });
  assert.deepEqual(layerSize({ quality: 'HIGH', box: boxOf(12) }, c), { radius: 12, pixel: 0.1 });
  assert.deepEqual(layerSize({ quality: 'MEDIUM', box: boxOf(29) }, c), { radius: 22, pixel: 0.25 });
  assert.deepEqual(layerSize({ quality: 'HIGH', box: boxOf(60) }, c), { radius: 42, pixel: 0.25 });
  assert.deepEqual(layerSize({ quality: 'LOW', box: null }, c), { radius: 19, pixel: 0.5 });
  for (const q of ['HIGH', 'MEDIUM', 'LOW', null]) {
    for (const m of [5, 20, 40, 60, 80, 120, 300]) {
      const { radius, pixel } = layerSize({ quality: q, box: boxOf(m) }, c);
      assert.ok(radius >= 12 && radius <= 60);
      assert.ok((2 * radius / pixel) ** 2 * 3 <= 4e6, `${q} ${m} m`);
    }
  }
});

test('speed: 800 x 800 grid with 30 faces, decode included, in under 1.5 s', async () => {
  // 15 small gables (30 faces) on one lot, 80 m across at 10 cm pixels.
  const faces = [];
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 3; j++) {
      const x = -100 + i * 50, y = -40 + j * 40;
      faces.push({ name: `s${i}${j}`, poly: [[x - 16, y - 12], [x + 16, y - 12], [x + 16, y], [x - 16, y]], rise: 6, az: 180, ref: [x, y - 12], zRef: 2.8 });
      faces.push({ name: `n${i}${j}`, poly: [[x - 16, y], [x + 16, y], [x + 16, y + 12], [x - 16, y + 12]], rise: 6, az: 0, ref: [x, y + 12], zRef: 2.8 });
    }
  }
  const village = makeHouse({ id: 'village', lat: 39.69, lng: -75.76, rotDeg: 7, quality: 'HIGH', faces });
  const t = trimInsights(insightsFor(village));
  const segments = t.segments.map(s => ({ ...s, rise: riseOf(s.pitchDeg), lowSlope: false }));
  const r = renderLayers(village.lat, village.lng, { radius: 40, pixel: 0.1, layers: ['mask', 'dsm'], house: village });
  assert.equal(r.dsm.w, 800);
  assert.equal(r.dsm.h, 800);
  const maskTif = encodeGeoTiff(r.mask), dsmTif = encodeGeoTiff(r.dsm);
  const t0 = performance.now();
  const [mask, dsm] = await Promise.all([readGeoTiff(maskTif), readGeoTiff(dsmTif)]);
  const m = measureRoof({ segments, center: t.building.center, mask, dsm });
  atticFloor({ building: t.building, segments, outline: m.outline, overhangM: FT });
  const ms = performance.now() - t0;
  assert.equal(m.faces.length, 30);
  assert.equal(m.edges.filter(e => e.type === 'ridge').length, 15);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  console.log(`# 800x800, 30 faces: ${ms.toFixed(0)} ms`);
});
