// Synthetic houses for the mock Google (dev/mock-google.js) and the tests. Dev only, never deployed.
//
// Each house is drawn in its own local frame: x east, y north, in feet, centered on the house, then turned
// clockwise by rotDeg (compass) and converted to meters. Faces are flat planes that do not overlap in plan;
// heights are meters above the lawn. The surface heights (DSM) put the lawn GROUND_ELEV meters up, while the
// Solar numbers (planeHeightAtCenterMeters) are above the lawn, so the two do not share a datum, as with Google.
//
// Analytic truth (feet; "true" = along the slope). 6/12 slope factor = sqrt(1 + 0.25) = 1.1180.
//
// (a) 1 Gable Ln: gable, 40 x 30 ft outline (drip edge), 6/12, ridge east-west, 1 ft overhang.
//     Outline 1200 sq ft, perimeter 140 ft. Ridge 40. Eaves 2 x 40 = 80. Rakes 4 x 15 x 1.1180 = 67.08.
//     Attic floor at 12 in overhang: 38 x 28 = 1064 sq ft. A detached flat shed (no Solar face) and a tree
//     stand nearby and must not count.
// (b) 2 Hip Rd: hip, 50 x 30 ft, 6/12, turned 25 degrees. Outline 1500 sq ft, perimeter 160 ft.
//     Ridge 50 - 30 = 20. Hips 4 x 21.21 plan, x 1.0607 along the hip (slope 0.5 x cos 45) = 4 x 22.5 = 90.
//     Eaves 2 x 50 + 2 x 30 = 160. Attic 48 x 28 = 1344 sq ft.
// (c) 3 Cross Gable Ct: L-shaped cross gable turned -10 degrees, all 6/12 except the porch.
//     Main block 50 x 28 ft (ridge east-west at 7 ft above the eave), a 20 x 20 ft front wing (ridge north-south,
//     5 ft above the eave) that runs into the main roof, and a 16 x 8 ft porch roof at 1/12 against the main
//     house wall, 0.6 m below the main eave, so its top edge is a wall line (step). A 3 x 2 ft chimney stands
//     3 ft proud on the back face.
//     Outline 50x28 + 20x20 + 16x8 = 1928 sq ft, perimeter 212 ft.
//     Ridges 50 + 30 = 80. Valleys 2 x 14.14 plan x 1.0607 = 2 x 15.0 = 30.0. Headwall (porch wall) 16.
//     Rakes 4 x 14 x 1.1180 + 2 x 10 x 1.1180 + 2 x 8 x 1.0035 = 101.02.
//     Eaves 50 + 30 + 20 + 20 + 16 = 136: the main front eave over the porch still counts (it has drip edge).
//     Porch is low slope (1/12) and 2 m below the main roof: excluded 128 sq ft. Attic at 12 in:
//     (1928 - 212 + 4) x (1 - 128/1928) = 1605.8.
// (d) 4 Low Detail Dr: LOW quality imagery; gable 36 x 26 ft at 8/12 plus a flat 12 x 16 ft carport with no
//     Solar face (faces cover 936 of 1128 sq ft = 83%). The mock's surface-heights file for it fails.
// (e) 5 Twin Ave: one half of a side-gable twin, 22 x 36 ft at 8/12 (slope factor 1.2019), ridge east-west.
//     The other half (x 11..33 ft) is the same roof, in the rooftop mask and the surface heights, but not in
//     Google's building (no Solar faces), so the two roofs touch along the party wall at x = 11.
//     This half: outline 792 sq ft, perimeter 80 ft of outside walls plus the 36 ft party wall. Attic at 12 in:
//     21 x 34 = 714 sq ft. Ridge 22, eaves 44, rakes 2 x 18 x 1.2019 = 43.27 (west end only). No edge along the
//     party wall. The outline is cut 0.5 m past Google's box (CONTRACT.md), so it measures about
//     23.64 x 36 = 851 sq ft and the attic about 772 (+8%), with sharedWallM about 36 ft.
// (f) 6 Flat Roof Plaza: commercial, every face 1/4 in per ft. Main block 80 x 50 ft (two faces from a crown at
//     y = 0, eaves 4.5 m up) and a 20 x 30 ft loading bay on the east side, 1.5 m lower, sloping east.
//     Outline 4600 sq ft, perimeter 300 ft. Nothing is left out by default (no steep faces): attic at 12 in
//     4600 - 300 + 4 = 4304. Headwall (bay against the main wall) 30. Crown ("ridge") 80.
// (g) 7 Cape Dormer Way: 1.5-story Cape, turned 12 degrees. Main block 36 x 28 ft at 12/12 (slope 1.4142), ridge
//     east-west, eaves 2.9 m up. A 24 x 12 ft shed dormer at 1.5/12 (1.0078) on the back runs from the ridge to
//     2 ft short of the back eave. An attached one-story garage, 22 x 20 ft at 3/12 (1.0308), on the east gable
//     end, eaves 2.4 m up. A 16 x 8 ft front porch at 1/12 (1.0035), its top 0.6 m under the main eave.
//     Outline 1008 + 440 + 128 = 1576 sq ft, perimeter 188 ft. Defaults: the porch is left out (low slope, more
//     than 1 m under the main roof), the dormer stays in (low slope but high), the garage stays in but is
//     marked lower. Attic at 12 in: (1576 - 188 + 4) x (1 - 128/1576) = 1278.9 (true: main + garage inset by
//     the overhang, 1448 - 172 + 4 = 1280). Outline length per face: front 38, back 54, dormer 0, garage
//     32 + 32, porch 32. Wall run with the porch out: 188 - 32 - 8 = 148.
//     Ridges 12 (main, two pieces) + 24 (dormer meets the front at the ridge) + 22 (garage) = 58.
//     Eaves 36 + 36 + 24 (dormer, over the back roof) + 44 (garage) + 16 (porch) = 156.
//     Rakes 28 x 1.4142 x 2 (both main gables, also where they rise above the garage) + 24 x 1.0078 (dormer
//     sides) + 20 x 1.0308 (garage) + 16 x 1.0035 (porch) = 140.05.
//     Step: dormer cheeks 2 x 12 x 1.4142 = 33.94 plus the garage against the gable wall 20 x 1.0308 = 20.62,
//     54.56 in all. Headwall: back roof under the dormer front 24 + porch top 16 = 40.

import { utm, zoneOfLatLng } from '../lib/takeoff.js';

export const FT = 0.3048;
export const GROUND_ELEV = 27.4;
const D2R = Math.PI / 180;
const WGS_A = 6378137, WGS_F = 1 / 298.257223563, E2 = WGS_F * (2 - WGS_F);

/* ---------- local frame: meters east/north of a lat/lng ---------- */

export function localFrame(lat0, lng0) {
  const phi = lat0 * D2R, w = 1 - E2 * Math.sin(phi) ** 2;
  const kN = WGS_A * (1 - E2) / (w * Math.sqrt(w)) * D2R, kE = WGS_A / Math.sqrt(w) * Math.cos(phi) * D2R;
  return {
    toLatLng: (x, y) => ({ lat: lat0 + y / kN, lng: lng0 + x / kE }),
    toLocal: (lat, lng) => [(lng - lng0) * kE, (lat - lat0) * kN],
  };
}

// Affine map between UTM and a local frame (exact to well under a millimeter over a few hundred meters).
function utmAffine(frame, zone) {
  const p0 = frame.toLatLng(0, 0), U0 = utm(p0.lat, p0.lng, zone), h = 20;
  const U = (x, y) => { const q = frame.toLatLng(x, y); return utm(q.lat, q.lng, zone); };
  const ex1 = U(h, 0), ex0 = U(-h, 0), ey1 = U(0, h), ey0 = U(0, -h);
  const a = (ex1.x - ex0.x) / (2 * h), c = (ex1.y - ex0.y) / (2 * h), b = (ey1.x - ey0.x) / (2 * h), d = (ey1.y - ey0.y) / (2 * h);
  const det = a * d - b * c;
  return {
    toUtm: (x, y) => [U0.x + a * x + b * y, U0.y + c * x + d * y],
    toLocal: (X, Y) => { const ex = X - U0.x, ey = Y - U0.y; return [(d * ex - b * ey) / det, (a * ey - c * ex) / det]; },
  };
}

/* ---------- building a house from a plan in feet ---------- */

const rot = (deg) => {
  const t = deg * D2R, c = Math.cos(t), s = Math.sin(t);
  return ([x, y]) => [x * c + y * s, -x * s + y * c]; // clockwise by deg, as a compass bearing
};

/**
 * spec: { id, address, lat, lng, rotDeg, quality, imageryDate, color: [r,g,b],
 *   faces: [{ name, poly: [[x,y] ft], rise, az (deg, before turning), ref: [x,y] ft, zRef (m above lawn),
 *             solar (default true; false = a neighbour's roof: in the mask and heights, not in Google's building) }],
 *   flats: [{ poly, z }]  (flat roof parts with no Solar face, in the rooftop mask)
 *   chimneys: [{ poly, above (ft over the roof at its center) }]
 *   sheds: [{ poly, z }] (separate small buildings, in the mask, no Solar face)
 *   trees: [{ at: [x,y] ft, r ft, h m, over (hangs over the roof), inMask (the rooftop mask counts it as roof) }],
 *   drive: poly ft, truth: {...} }
 */
export function makeHouse(spec) {
  const turn = rot(spec.rotDeg || 0);
  const m = p => turn([p[0] * FT, p[1] * FT]);
  const box = poly => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1 };
  };
  const faces = spec.faces.map(f => {
    const az = f.az + (spec.rotDeg || 0);
    const d = [Math.sin(az * D2R), Math.cos(az * D2R)];
    const poly = f.poly.map(m);
    return { name: f.name, poly, box: box(poly), m: f.rise / 12, rise: f.rise, azDeg: ((az % 360) + 360) % 360, d, ref: m(f.ref), zRef: f.zRef, solar: f.solar !== false };
  });
  const flats = (spec.flats || []).map(f => { const poly = f.poly.map(m); return { poly, box: box(poly), z: f.z }; });
  const sheds = (spec.sheds || []).map(f => { const poly = f.poly.map(m); return { poly, box: box(poly), z: f.z }; });
  const chimneys = (spec.chimneys || []).map(c => {
    const poly = c.poly.map(m), bx = box(poly), cx = (bx.x0 + bx.x1) / 2, cy = (bx.y0 + bx.y1) / 2;
    const under = faces.map(f => (inPoly(f.poly, cx, cy) ? planeZ(f, cx, cy) : -Infinity)).reduce((a, b) => Math.max(a, b), 0);
    return { poly, box: bx, z: under + c.above * FT };
  });
  const trees = (spec.trees || []).map(t => { const [x, y] = m(t.at); return { x, y, r: t.r * FT, h: t.h, over: !!t.over, inMask: !!t.inMask }; });
  const drive = spec.drive ? spec.drive.map(m) : null;
  const all = [...faces.filter(f => f.solar), ...flats, ...chimneys].map(f => f.box);
  const bbox = { x0: Math.min(...all.map(b => b.x0)), x1: Math.max(...all.map(b => b.x1)), y0: Math.min(...all.map(b => b.y0)), y1: Math.max(...all.map(b => b.y1)) };
  const frame = localFrame(spec.lat, spec.lng);
  const zone = zoneOfLatLng(spec.lat, spec.lng);
  return { ...spec, faces, flats, sheds, chimneys, trees, drive, bbox, frame, zone, affine: utmAffine(frame, zone) };
}

export function inPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const inBox = (b, x, y, pad = 0) => x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
export const planeZ = (f, x, y) => f.zRef - f.m * ((x - f.ref[0]) * f.d[0] + (y - f.ref[1]) * f.d[1]);

// What is at local point (x, y) meters: { kind, z (m above lawn), face (index) }.
const treeZ = (t, r2) => t.h * Math.sqrt(1 - r2 / (t.r * t.r)) * 0.4 + t.h * 0.6;
export function surfaceAt(h, x, y) {
  for (const t of h.trees) {
    if (!t.over) continue;
    const r2 = (x - t.x) ** 2 + (y - t.y) ** 2;
    if (r2 < t.r * t.r) return { kind: t.inMask ? 'canopy' : 'tree', z: treeZ(t, r2), face: -1, tree: t };
  }
  for (const c of h.chimneys) if (inBox(c.box, x, y) && inPoly(c.poly, x, y)) return { kind: 'chimney', z: c.z, face: -1 };
  for (let k = 0; k < h.faces.length; k++) {
    const f = h.faces[k];
    if (inBox(f.box, x, y) && inPoly(f.poly, x, y)) return { kind: 'face', z: planeZ(f, x, y), face: k };
  }
  for (const f of h.flats) if (inBox(f.box, x, y) && inPoly(f.poly, x, y)) return { kind: 'flat', z: f.z, face: -1 };
  for (const f of h.sheds) if (inBox(f.box, x, y) && inPoly(f.poly, x, y)) return { kind: 'shed', z: f.z, face: -1 };
  for (const t of h.trees) {
    const r2 = (x - t.x) ** 2 + (y - t.y) ** 2;
    if (r2 < t.r * t.r) return { kind: 'tree', z: treeZ(t, r2), face: -1, tree: t };
  }
  if (h.drive && inPoly(h.drive, x, y)) return { kind: 'drive', z: 0, face: -1 };
  return { kind: 'ground', z: 0, face: -1 };
}

const isRoof = s => s.kind === 'face' || s.kind === 'flat' || s.kind === 'chimney' || s.kind === 'shed' || s.kind === 'canopy';

/* ---------- the mock houses ---------- */


// The drawings (feet), for tests that redraw a house with a change; HOUSES below are the built houses.
export const HOUSE_SPECS = [
  {
    id: 'gable', address: '1 Gable Ln, Newark, DE 19711, USA', match: /\b1\s+gable\b/i,
    lat: 39.68, lng: -75.75, rotDeg: 0, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [70, 72, 78],
    faces: [
      { name: 'south', poly: [[-20, -15], [20, -15], [20, 0], [-20, 0]], rise: 6, az: 180, ref: [0, -15], zRef: 2.8 },
      { name: 'north', poly: [[-20, 0], [20, 0], [20, 15], [-20, 15]], rise: 6, az: 0, ref: [0, 15], zRef: 2.8 },
    ],
    sheds: [{ poly: [[-48, -9], [-38, -9], [-38, -1], [-48, -1]], z: 2.4 }],
    trees: [{ at: [36, 22], r: 11, h: 8 }],
    drive: [[6, -15], [18, -15], [18, -80], [6, -80]],
    truth: { outlineFt2: 1200, perimeterFt: 140, attic12Ft2: 1064, ft: { ridge: 40, eave: 80, rake: 4 * 15 * Math.sqrt(1.25), hip: 0, valley: 0, step: 0, break: 0 } },
  },
  {
    id: 'hip', address: '2 Hip Rd, Newark, DE 19711, USA', match: /\b2\s+hip\b/i,
    lat: 39.68, lng: -75.748, rotDeg: 25, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [104, 80, 62],
    faces: [
      { name: 'south', poly: [[-25, -15], [25, -15], [10, 0], [-10, 0]], rise: 6, az: 180, ref: [0, -15], zRef: 2.8 },
      { name: 'north', poly: [[-25, 15], [-10, 0], [10, 0], [25, 15]], rise: 6, az: 0, ref: [0, 15], zRef: 2.8 },
      { name: 'east', poly: [[25, -15], [25, 15], [10, 0]], rise: 6, az: 90, ref: [25, 0], zRef: 2.8 },
      { name: 'west', poly: [[-25, -15], [-10, 0], [-25, 15]], rise: 6, az: 270, ref: [-25, 0], zRef: 2.8 },
    ],
    trees: [{ at: [-40, 25], r: 12, h: 9 }],
    drive: [[-20, -15], [-8, -15], [-8, -70], [-20, -70]],
    truth: { outlineFt2: 1500, perimeterFt: 160, attic12Ft2: 1344, ft: { ridge: 20, hip: 90, eave: 160, rake: 0, valley: 0, step: 0, break: 0 } },
  },
  {
    id: 'cross', address: '3 Cross Gable Ct, Newark, DE 19711, USA', match: /\b3\s+cross\b/i,
    lat: 39.6815, lng: -75.75, rotDeg: -10, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [78, 88, 104],
    faces: [
      { name: 'back', poly: [[-25, 14], [25, 14], [25, 28], [-25, 28]], rise: 6, az: 0, ref: [0, 28], zRef: 2.9 },
      { name: 'front', poly: [[-25, 0], [2, 0], [12, 10], [22, 0], [25, 0], [25, 14], [-25, 14]], rise: 6, az: 180, ref: [0, 0], zRef: 2.9 },
      { name: 'wing west', poly: [[2, -20], [12, -20], [12, 10], [2, 0]], rise: 6, az: 270, ref: [2, 0], zRef: 2.9 },
      { name: 'wing east', poly: [[12, -20], [22, -20], [22, 0], [12, 10]], rise: 6, az: 90, ref: [22, 0], zRef: 2.9 },
      { name: 'porch', poly: [[-20, -8], [-4, -8], [-4, 0], [-20, 0]], rise: 1, az: 180, ref: [-12, 0], zRef: 2.3 },
    ],
    chimneys: [{ poly: [[-15, 19], [-12, 19], [-12, 21], [-15, 21]], above: 3 }],
    trees: [{ at: [-40, 40], r: 13, h: 10 }],
    drive: [[8, -20], [18, -20], [18, -75], [8, -75]],
    truth: {
      outlineFt2: 1928, perimeterFt: 212, attic12Ft2: (1928 - 212 + 4) * (1 - 128 / 1928), excludedFt2: 128,
      ft: { ridge: 80, valley: 2 * Math.hypot(10, 10) * Math.sqrt(1 + 0.125), step: 0, headwall: 16, rake: 4 * 14 * Math.sqrt(1.25) + 2 * 10 * Math.sqrt(1.25) + 2 * 8 * Math.sqrt(1 + 1 / 144), eave: 136, hip: 0, break: 0 },
    },
  },
  {
    id: 'low', address: '4 Low Detail Dr, Newark, DE 19711, USA', match: /\b4\s+low\b/i,
    lat: 39.6815, lng: -75.748, rotDeg: 15, quality: 'LOW', imageryDate: { year: 2019, month: 9 }, color: [120, 70, 58], dsmFails: true,
    faces: [
      { name: 'south', poly: [[-18, -13], [18, -13], [18, 0], [-18, 0]], rise: 8, az: 180, ref: [0, -13], zRef: 2.7 },
      { name: 'north', poly: [[-18, 0], [18, 0], [18, 13], [-18, 13]], rise: 8, az: 0, ref: [0, 13], zRef: 2.7 },
    ],
    flats: [{ poly: [[18, -8], [30, -8], [30, 8], [18, 8]], z: 2.6 }],
    drive: [[20, -8], [30, -8], [30, -70], [20, -70]],
    truth: { outlineFt2: 1128, perimeterFt: 2 * (36 + 26) + 2 * 12, ft: {} },
  },
  {
    id: 'twin', address: '5 Twin Ave, Newark, DE 19711, USA', match: /\b5\s+twin\b/i,
    lat: 39.6785, lng: -75.75, rotDeg: 0, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [92, 84, 80],
    faces: [
      { name: 'front', poly: [[-11, -18], [11, -18], [11, 0], [-11, 0]], rise: 8, az: 180, ref: [0, -18], zRef: 5.6 },
      { name: 'back', poly: [[-11, 0], [11, 0], [11, 18], [-11, 18]], rise: 8, az: 0, ref: [0, 18], zRef: 5.6 },
      // The other half of the twin: the same roof, but not Google's building.
      { name: 'next door front', poly: [[11, -18], [33, -18], [33, 0], [11, 0]], rise: 8, az: 180, ref: [22, -18], zRef: 5.6, solar: false },
      { name: 'next door back', poly: [[11, 0], [33, 0], [33, 18], [11, 18]], rise: 8, az: 0, ref: [22, 18], zRef: 5.6, solar: false },
    ],
    trees: [{ at: [-26, 26], r: 9, h: 9 }],
    drive: [[-9, -18], [1, -18], [1, -75], [-9, -75]],
    truth: {
      outlineFt2: 792, perimeterFt: 80 + 36, sharedWallFt: 36, attic12Ft2: 21 * 34,
      // What the contract's 0.5 m allowance past Google's box gives (see the note above).
      cutOutlineFt2: (22 + 0.5 / FT) * 36, cutAttic12Ft2: (22 + 0.5 / FT) * 36 - (2 * (22 + 0.5 / FT) + 36) + 4,
      ft: { ridge: 22, eave: 44, rake: 2 * 18 * Math.sqrt(1 + (8 / 12) ** 2), hip: 0, valley: 0, step: 0, headwall: 0, break: 0 },
    },
  },
  {
    id: 'flat', address: '6 Flat Roof Plaza, Newark, DE 19711, USA', match: /\b6\s+flat\b/i,
    lat: 39.6785, lng: -75.748, rotDeg: -6, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [150, 150, 146],
    faces: [
      { name: 'south', poly: [[-40, -25], [40, -25], [40, 0], [-40, 0]], rise: 0.25, az: 180, ref: [0, -25], zRef: 4.5 },
      { name: 'north', poly: [[-40, 0], [40, 0], [40, 25], [-40, 25]], rise: 0.25, az: 0, ref: [0, 25], zRef: 4.5 },
      { name: 'loading bay', poly: [[40, -15], [60, -15], [60, 15], [40, 15]], rise: 0.25, az: 90, ref: [40, 0], zRef: 3.0 },
    ],
    drive: [[-30, -25], [30, -25], [30, -70], [-30, -70]],
    truth: { outlineFt2: 4600, perimeterFt: 300, attic12Ft2: 4600 - 300 + 4, ft: { headwall: 30, ridge: 80 } },
  },
  {
    id: 'cape', address: '7 Cape Dormer Way, Newark, DE 19711, USA', match: /\b7\s+cape\b/i,
    lat: 39.6785, lng: -75.746, rotDeg: 12, quality: 'HIGH', imageryDate: { year: 2024, month: 5, day: 14 }, color: [84, 76, 70],
    faces: [
      { name: 'front', poly: [[-18, -14], [18, -14], [18, 0], [-18, 0]], rise: 12, az: 180, ref: [0, -14], zRef: 2.9 },
      { name: 'back', poly: [[-18, 0], [-12, 0], [-12, 12], [12, 12], [12, 0], [18, 0], [18, 14], [-18, 14]], rise: 12, az: 0, ref: [0, 14], zRef: 2.9 },
      { name: 'dormer', poly: [[-12, 0], [12, 0], [12, 12], [-12, 12]], rise: 1.5, az: 0, ref: [0, 0], zRef: 2.9 + 14 * FT },
      { name: 'garage south', poly: [[18, -10], [40, -10], [40, 0], [18, 0]], rise: 3, az: 180, ref: [29, -10], zRef: 2.4 },
      { name: 'garage north', poly: [[18, 0], [40, 0], [40, 10], [18, 10]], rise: 3, az: 0, ref: [29, 10], zRef: 2.4 },
      { name: 'porch', poly: [[-10, -22], [6, -22], [6, -14], [-10, -14]], rise: 1, az: 180, ref: [-2, -14], zRef: 2.3 },
    ],
    trees: [{ at: [-34, 30], r: 10, h: 10 }],
    drive: [[22, -10], [36, -10], [36, -75], [22, -75]],
    truth: {
      outlineFt2: 1576, perimeterFt: 188, attic12Ft2: (1576 - 188 + 4) * (1 - 128 / 1576), excludedFt2: 128, wallRun12Ft: 148,
      perimeterByFaceFt: { front: 38, back: 54, dormer: 0, 'garage south': 32, 'garage north': 32, porch: 32 },
      ft: {
        ridge: 58, eave: 156, valley: 0, hip: 0, break: 0, headwall: 40,
        rake: 4 * 14 * Math.SQRT2 + 24 * Math.sqrt(1 + (1.5 / 12) ** 2) + 20 * Math.sqrt(1 + (3 / 12) ** 2) + 16 * Math.sqrt(1 + (1 / 12) ** 2),
        step: 24 * Math.SQRT2 + 20 * Math.sqrt(1 + (3 / 12) ** 2),
      },
    },
  },
];
export const HOUSES = HOUSE_SPECS.map(makeHouse);

// Where "no roof" addresses land: an empty field with no building nearby.
export const EMPTY_FIELD = { lat: 39.683, lng: -75.753 };
const TOWN = localFrame(39.6807, -75.749);

export function houseFor(address) {
  return HOUSES.find(h => h.match.test(address)) || HOUSES[2];
}

export function nearestHouse(lat, lng, maxM) {
  let best = null, bd = Infinity;
  for (const h of HOUSES) {
    const [x, y] = h.frame.toLocal(lat, lng), d = Math.hypot(x, y);
    if (d < bd) { bd = d; best = h; }
  }
  return bd <= maxM ? best : null;
}

/* ---------- Solar buildingInsights for a house ---------- */

const polyArea = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
function centroid(p) {
  let A = 0, cx = 0, cy = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i], b = p[(i + 1) % p.length], c = a[0] * b[1] - b[0] * a[1];
    A += c; cx += (a[0] + b[0]) * c; cy += (a[1] + b[1]) * c;
  }
  return [cx / (3 * A), cy / (3 * A)];
}

export function insightsFor(h) {
  const ll = (x, y) => { const p = h.frame.toLatLng(x, y); return { latitude: p.lat, longitude: p.lng }; };
  const bb = b => ({ sw: ll(b.x0, b.y0), ne: ll(b.x1, b.y1) });
  const quant = [0, 900, 1100, 1200, 1250, 1300, 1320, 1340, 1360, 1380, 1400];
  const segs = h.faces.filter(f => f.solar).map(f => {
    const g = polyArea(f.poly), [cx, cy] = centroid(f.poly);
    return {
      pitchDegrees: Math.atan(f.m) / D2R, azimuthDegrees: f.azDeg,
      stats: { areaMeters2: g * Math.sqrt(1 + f.m * f.m), sunshineQuantiles: quant, groundAreaMeters2: g },
      center: ll(cx, cy), boundingBox: bb(f.box), planeHeightAtCenterMeters: planeZ(f, cx, cy),
    };
  });
  const faceGround = segs.reduce((s, x) => s + x.stats.groundAreaMeters2, 0), faceArea = segs.reduce((s, x) => s + x.stats.areaMeters2, 0);
  const flatGround = h.flats.reduce((s, f) => s + polyArea(f.poly), 0);
  const c = ll((h.bbox.x0 + h.bbox.x1) / 2, (h.bbox.y0 + h.bbox.y1) / 2);
  return {
    name: `buildings/mock-${h.id}`,
    center: c,
    imageryDate: h.imageryDate,
    imageryProcessedDate: { year: 2025, month: 1, day: 10 },
    postalCode: '19711', administrativeArea: 'DE', statisticalArea: '10003014900', regionCode: 'US',
    boundingBox: bb(h.bbox),
    imageryQuality: h.quality,
    solarPotential: {
      maxArrayPanelsCount: Math.round(faceGround / 2), panelCapacityWatts: 400,
      wholeRoofStats: { areaMeters2: faceArea, sunshineQuantiles: quant, groundAreaMeters2: faceGround },
      buildingStats: { areaMeters2: faceArea + flatGround, sunshineQuantiles: quant, groundAreaMeters2: faceGround + flatGround },
      // Google lists faces in no particular order.
      roofSegmentStats: segs.slice().reverse(),
    },
  };
}

/* ---------- rasters ---------- */

// Deterministic per-pixel noise in [-1, 1).
function hash2(i, j, seed) {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}
function smoothNoise(x, y, scale, seed) {
  const gx = x / scale, gy = y / scale, i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy;
}

const SUN_AZ = 160 * D2R, SUN_EL = 55 * D2R;
const SUN = [Math.cos(SUN_EL) * Math.sin(SUN_AZ), Math.cos(SUN_EL) * Math.cos(SUN_AZ), Math.sin(SUN_EL)];
const clamp8 = v => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// Street and sidewalk run east-west through town, 27 m south of each row of houses.
let streets = null;
function townGround(wx, wy) {
  if (!streets) streets = [...new Set(HOUSES.map(h => Math.round(TOWN.toLocal(h.lat, h.lng)[1] - 27)))];
  for (const sy of streets) {
    const d = wy - sy;
    if (Math.abs(d) < 4) return Math.abs(d) < 0.08 && Math.floor(wx / 3) % 2 === 0 ? [205, 180, 80] : [64, 66, 70];
    if (Math.abs(d) < 5.6 && Math.abs(d) >= 4.4) return [180, 178, 172];
  }
  return null;
}

// Color of the world at local point (x, y) of house h (and world point wx, wy).
function colorAt(h, x, y, wx, wy) {
  const s = h ? surfaceAt(h, x, y) : { kind: 'ground' };
  const n = smoothNoise(wx, wy, 1.7, 7) * 10 + smoothNoise(wx, wy, 0.35, 9) * 7;
  if (s.kind === 'face') {
    const f = h.faces[s.face], L = Math.hypot(f.m, 1);
    const nx = f.m * f.d[0] / L, ny = f.m * f.d[1] / L, nz = 1 / L;
    const lit = 0.45 + 0.75 * Math.max(0, nx * SUN[0] + ny * SUN[1] + nz * SUN[2]);
    const along = (x - f.ref[0]) * f.d[0] + (y - f.ref[1]) * f.d[1];
    const course = ((along / 0.34) % 1 + 1) % 1 < 0.16 ? 0.82 : 1;
    const c = h.color, k = lit * course;
    return [clamp8(c[0] * k + n * 0.4), clamp8(c[1] * k + n * 0.4), clamp8(c[2] * k + n * 0.4)];
  }
  if (s.kind === 'chimney') return [clamp8(150 + n), clamp8(70 + n * 0.5), 56];
  if (s.kind === 'flat') return [clamp8(168 + n * 0.6), clamp8(168 + n * 0.6), clamp8(162 + n * 0.6)];
  if (s.kind === 'shed') return [clamp8(126 + n * 0.5), clamp8(118 + n * 0.5), clamp8(108 + n * 0.5)];
  let col;
  if (s.kind === 'tree' || s.kind === 'canopy') {
    const t = s.tree, r = Math.hypot(x - t.x, y - t.y) / t.r, lit = 0.75 + 0.35 * ((x - t.x) * Math.sin(SUN_AZ) + (y - t.y) * Math.cos(SUN_AZ)) / t.r;
    const leaf = smoothNoise(wx, wy, 0.6, 3) * 18;
    return [clamp8((38 + leaf) * lit * (1.05 - 0.2 * r)), clamp8((80 + leaf) * lit * (1.05 - 0.2 * r)), clamp8((34 + leaf * 0.5) * lit)];
  }
  if (s.kind === 'drive') col = [152 + n * 0.5, 150 + n * 0.5, 144 + n * 0.5];
  else col = townGround(wx, wy) || [86 + n, 124 + n * 1.3, 58 + n * 0.6];
  // Shadow: the house or a tree blocks the sun a little toward it.
  if (h) {
    const k = 1.6, sx = x + Math.sin(SUN_AZ) * k, sy = y + Math.cos(SUN_AZ) * k, o = surfaceAt(h, sx, sy);
    if (isRoof(o) || o.kind === 'tree') col = col.map(v => v * 0.6);
  }
  return col.map(clamp8);
}

function sceneAt(X, Y) {
  // X, Y: UTM meters (zone 18). Returns { h, x, y } for the house whose patch holds the point, else null.
  for (const h of HOUSES) {
    const [x, y] = h.affine.toLocal(X, Y);
    if (Math.abs(x) < 70 && Math.abs(y) < 70) return { h, x, y };
  }
  return null;
}

const TOWN_AFFINE = utmAffine(TOWN, zoneOfLatLng(39.68, -75.75));

/**
 * Renders Google-like rasters around (lat, lng). Returns { rgb, mask, dsm }, each a raster
 * { w, h, res, resY, minX, maxY, zone, data } (rgb data is 3-band interleaved Uint8Array).
 * opts: radius, pixel; dsmPixel (default pixel), dsmPad (extra DSM pixels each side, default 0),
 * dsmShift (meters added to the DSM grid origin), noise (DSM noise, default 0.03 m), house (render only this
 * house, for tests), layers (subset of ['rgb','mask','dsm']).
 */
export function renderLayers(lat, lng, opts) {
  const zone = zoneOfLatLng(lat, lng), c = utm(lat, lng, zone);
  // A square 2 x radius across, snapped to whole pixels, like Google's files.
  const grid = (px, pad = 0, shift = 0) => {
    const n = Math.round(2 * opts.radius / px) + 2 * pad;
    const minX = Math.round((c.x - opts.radius) / px) * px - pad * px + shift, maxY = Math.round((c.y + opts.radius) / px) * px + pad * px + shift;
    return { w: n, h: n, res: px, resY: px, minX, maxY, zone };
  };
  const only = opts.house || null;
  const look = (X, Y) => {
    if (only) { const [x, y] = only.affine.toLocal(X, Y); return { h: only, x, y }; }
    return sceneAt(X, Y);
  };
  const layers = opts.layers || ['rgb', 'mask', 'dsm'];
  const out = {};
  const pixel = opts.pixel;
  if (layers.includes('rgb') || layers.includes('mask')) {
    const g = grid(pixel), N = g.w * g.h;
    const rgb = layers.includes('rgb') ? new Uint8Array(N * 3) : null, mask = layers.includes('mask') ? new Uint8Array(N) : null;
    for (let v = 0; v < g.h; v++) {
      const Y = g.maxY - (v + 0.5) * pixel;
      for (let u = 0; u < g.w; u++) {
        const X = g.minX + (u + 0.5) * pixel, i = v * g.w + u, sc = look(X, Y);
        if (mask && sc) mask[i] = isRoof(surfaceAt(sc.h, sc.x, sc.y)) ? 1 : 0;
        if (rgb) {
          const [wx, wy] = TOWN_AFFINE.toLocal(X, Y);
          const col = colorAt(sc && sc.h, sc ? sc.x : 0, sc ? sc.y : 0, wx, wy);
          rgb[i * 3] = col[0]; rgb[i * 3 + 1] = col[1]; rgb[i * 3 + 2] = col[2];
        }
      }
    }
    if (rgb) out.rgb = { ...g, bands: 3, data: rgb };
    if (mask) out.mask = { ...g, data: mask };
  }
  if (layers.includes('dsm')) {
    const px = opts.dsmPixel || pixel, g = grid(px, opts.dsmPad || 0, opts.dsmShift || 0), N = g.w * g.h;
    const noise = opts.noise == null ? 0.03 : opts.noise, seed = opts.seed || 1;
    const data = new Float32Array(N);
    for (let v = 0; v < g.h; v++) {
      const Y = g.maxY - (v + 0.5) * px;
      for (let u = 0; u < g.w; u++) {
        const X = g.minX + (u + 0.5) * px, sc = look(X, Y);
        const z = sc ? surfaceAt(sc.h, sc.x, sc.y).z : 0;
        data[v * g.w + u] = GROUND_ELEV + z + noise * hash2(Math.round(X / px), Math.round(Y / px), seed);
      }
    }
    out.dsm = { ...g, data };
  }
  return out;
}

// Color at a lat/lng, for the mock satellite image.
// (Linear maps only: the satellite image has 1.6 million pixels.)
export function colorAtLatLng(lat, lng) {
  const [wx, wy] = TOWN.toLocal(lat, lng), [X, Y] = TOWN_AFFINE.toUtm(wx, wy), sc = sceneAt(X, Y);
  return colorAt(sc && sc.h, sc ? sc.x : 0, sc ? sc.y : 0, wx, wy);
}
