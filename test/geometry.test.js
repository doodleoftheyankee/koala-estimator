// Geometry of lib/takeoff.js on in-memory synthetic rasters (dev/houses.js holds the analytic truth).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUSES, makeHouse, insightsFor, renderLayers, FT, GROUND_ELEV } from '../dev/houses.js';
import { encodeGeoTiff } from '../dev/tiff.js';
import { trimInsights } from '../lib/google.js';
import { readGeoTiff } from '../lib/raster.js';
import {
  measureRoof, atticFloor, layerSize, riseOf, utm, utmInverse, zoneOfLatLng, latLngFrame, offsetPoly, EDGE_TYPES,
} from '../lib/takeoff.js';

const F2 = FT * FT;
const [GABLE, HIP, CROSS] = HOUSES;

function setup(house, opts = {}) {
  const t = trimInsights(insightsFor(house));
  const segments = t.segments.map(s => ({ ...s, rise: riseOf(s.pitchDeg), lowSlope: riseOf(s.pitchDeg) < 2 }));
  const rasters = renderLayers(house.lat, house.lng, { radius: 25, pixel: 0.1, layers: ['mask', 'dsm'], house, noise: 0.03, ...opts });
  return { building: t.building, segments, ...rasters };
}

function measure(house, opts) {
  const s = setup(house, opts);
  const m = measureRoof({ segments: s.segments, center: s.building.center, mask: s.mask, dsm: s.dsm });
  const attic = atticFloor({ building: s.building, segments: s.segments, outline: m.outline, overhangM: FT });
  return { ...s, ...m, attic };
}

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

test('cross gable: valleys, porch wall step, porch left out of the attic, chimney ignored', () => {
  const m = measure(CROSS);
  near(m.outline.areaM2 / F2, 1928, 0.02, 'outline area');
  near(m.outline.perimeterM / FT, 212, 0.02, 'outline perimeter');
  const t = totalsFt(m), truth = CROSS.truth.ft;
  near(t.valley, truth.valley, 0.05, 'valleys');
  assert.equal(m.edges.filter(e => e.type === 'valley').length, 2);
  near(t.ridge, truth.ridge, 0.05, 'ridges');
  near(t.rake, truth.rake, 0.05, 'rakes');
  near(t.eave, truth.eave, 0.05, 'eaves');
  assert.ok(t.hip < 1.5 && t.break < 1.5, `no hips or breaks: ${t.hip}, ${t.break}`);
  const porch = m.segments.find(s => s.lowSlope);
  assert.ok(porch, 'the porch is low slope');
  assert.equal(porch.rise, 1);
  // The porch's top edge meets the house wall: a step, the length of the porch.
  const steps = m.edges.filter(e => e.type === 'step');
  assert.equal(steps.length, 1);
  assert.ok(steps[0].faces.includes(porch.n));
  near(steps[0].planM / FT, 16, 0.08, 'porch wall');
  // The chimney sits on the back face: the face still comes out whole and adds no edges.
  const back = m.faces.find(f => f.n === m.segments.find(s => s.groundM2 > 60 && s.azimuthDeg > 300).n);
  near(back.planM2 / F2, 700 - 6, 0.03, 'back face minus the chimney');
  assert.deepEqual(m.attic.excluded, [porch.n]);
  near(m.attic.excludedM2 / F2, 128, 0.01, 'excluded area');
  near(m.attic.floorM2 / F2, CROSS.truth.attic12Ft2, 0.02, 'attic floor');
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
