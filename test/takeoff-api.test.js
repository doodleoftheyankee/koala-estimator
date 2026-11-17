// GET /api/takeoff (and /api/satellite, /api/geotiff) through the full mock Google path: GeoTIFFs are written by the
// mock and read back by the server, exactly as with Google.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import takeoff from '../api/takeoff.js';
import geotiff from '../api/geotiff.js';
import satellite from '../api/satellite.js';
import { createMockGoogle } from '../dev/mock-google.js';
import { HOUSES, FT } from '../dev/houses.js';
import { EDGE_TYPES } from '../lib/takeoff.js';

const KEY = 'TEST-KEY-must-never-leak-3f9a';
const F2 = FT * FT;
const [GABLE, HIP, CROSS, , TWIN, FLAT, CAPE] = HOUSES;
const ATTIC_KEYS = ['overhangM', 'footprintM2', 'perimeterM', 'perimeterSource', 'sharedWallM', 'unmatchedM2', 'perimeterByFaceM',
  'excluded', 'excludedM2', 'floorM2', 'wallRunM', 'deckM2'];
const SEGMENT_KEYS = ['n', 'pitchDeg', 'azimuthDeg', 'areaM2', 'groundM2', 'center', 'box', 'heightM', 'rise', 'lowSlope', 'lower'];

// CONTRACT.md "Attic floor" from the numbers on the wire, with the server's default face choices.
function contractAttic(j) {
  const a = j.attic, A = a.footprintM2, P = a.perimeterM, S = a.sharedWallM, d = a.overhangM;
  const out = j.segments.filter(s => a.excluded.includes(s.n)), kept = j.segments.filter(s => !a.excluded.includes(s.n));
  const ex = out.reduce((t, s) => t + s.groundM2, 0), exPerim = out.reduce((t, s) => t + (a.perimeterByFaceM[s.n] || 0), 0);
  const floor = Math.max(0, A - (P - S) * d + 4 * d * d) * Math.max(0, 1 - ex / A);
  const g = kept.reduce((t, s) => t + s.groundM2, 0), ar = kept.reduce((t, s) => t + s.areaM2, 0);
  return {
    floor, wallRun: Math.max(0, P - S - exPerim - 8 * d), deck: kept.length ? floor * ar / g : null, excludedM2: ex,
    unmatched: Math.max(0, A - j.segments.reduce((t, s) => t + s.groundM2, 0)),
  };
}
let logs = [], bodies = [], origError, origWarn, mock;

function useMock(opts) {
  mock = createMockGoogle(opts);
  globalThis.ROOF_FETCH = mock.fetch;
  return mock;
}

beforeEach(() => {
  process.env.GOOGLE_MAPS_API_KEY = KEY;
  delete process.env.ACCESS_CODE;
  delete process.env.PARTNER_KEY;
  useMock();
  logs = [];
  origError = console.error; origWarn = console.warn;
  console.error = (...a) => logs.push(a.map(x => (x && x.stack) || String(x)).join(' '));
  console.warn = console.error;
});

afterEach(() => {
  console.error = origError; console.warn = origWarn;
  for (const l of logs) assert.ok(!l.includes(KEY), `the API key leaked into a log line: ${l}`);
  for (const b of bodies) assert.ok(!b.includes(KEY), 'the API key leaked into a response');
  bodies = [];
  delete globalThis.ROOF_FETCH;
});

// Runs a Vercel-style handler with a fake request and response.
function call(handler, url, headers = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) {
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
        const text = buf.toString('utf8');
        bodies.push(text);
        resolve({ status: this.statusCode, headers: this.headers, buf, text, json: () => JSON.parse(text) });
      },
    };
    Promise.resolve(handler({ method: 'GET', url, headers }, res)).catch(reject);
  });
}
const get = (url, headers) => call(takeoff, url, headers);
const q = o => '/api/takeoff?' + new URLSearchParams(o);

function near(got, want, frac, label) {
  assert.ok(Math.abs(got - want) <= frac * Math.abs(want), `${label}: got ${got.toFixed(3)}, want ${want.toFixed(3)} (within ${frac * 100}%)`);
}

const decimals = v => { const s = String(v), i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };

test('takeoff by address: gable, every number where the contract says', async () => {
  const r = await get(q({ address: '1 Gable Ln' }));
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.match(r.headers['content-type'], /application\/json/);
  assert.ok(r.buf.length < 50000, `response is ${r.buf.length} bytes`);
  const j = r.json();
  assert.equal(j.version, 1);
  assert.deepEqual(Object.keys(j), ['version', 'place', 'building', 'segments', 'photo', 'outline', 'faces', 'edges', 'edgeTotalsM', 'attic', 'warnings']);
  assert.equal(j.place.address, GABLE.address);
  assert.equal(j.place.precision, 'ROOFTOP');
  assert.equal(j.building.quality, 'HIGH');
  assert.equal(j.segments.length, 2);
  for (const s of j.segments) {
    assert.deepEqual(Object.keys(s), SEGMENT_KEYS);
    assert.equal(s.rise, 6);
    assert.equal(s.lowSlope, false);
    assert.equal(s.lower, false);
    assert.ok(s.center && s.box && Number.isFinite(s.heightM));
  }
  assert.equal(typeof j.photo.rgb, 'string');
  assert.equal(j.photo.pixel, 0.1);
  assert.equal(j.photo.quality, 'HIGH');
  near(j.outline.areaM2 / F2, 1200, 0.02, 'outline');
  near(j.outline.perimeterM / FT, 140, 0.02, 'perimeter');
  assert.equal(j.faces.length, 2);
  assert.deepEqual(Object.keys(j.edgeTotalsM), EDGE_TYPES);
  near(j.edgeTotalsM.ridge / FT, 40, 0.05, 'ridge');
  near(j.edgeTotalsM.eave / FT, 80, 0.05, 'eaves');
  near(j.edgeTotalsM.rake / FT, 67.08, 0.05, 'rakes');
  for (const e of j.edges) {
    assert.ok(EDGE_TYPES.includes(e.type));
    assert.equal(e.path.length, 2);
    for (const p of e.path) assert.ok(decimals(p.lat) <= 7 && decimals(p.lng) <= 7);
    assert.ok(decimals(e.lengthM) <= 3);
  }
  assert.equal(j.attic.overhangM, 0.3048);
  assert.deepEqual(Object.keys(j.attic), ATTIC_KEYS);
  assert.equal(j.attic.perimeterSource, 'outline');
  assert.deepEqual(j.attic.excluded, []);
  assert.equal(j.attic.sharedWallM, 0);
  assert.ok(j.attic.unmatchedM2 < 1);
  near(j.attic.floorM2 / F2, 1064, 0.02, 'attic floor');
  near(j.attic.deckM2 / F2, 1064 * Math.sqrt(1.25), 0.02, 'roof deck over the attic floor');
  for (const s of j.segments) near(j.attic.perimeterByFaceM[s.n] / FT, 70, 0.02, `face ${s.n} outline length`);
  assert.deepEqual(j.warnings, []);
});

test('takeoff by map pin: cross gable with a 6 in overhang; clients can redo the attic math', async () => {
  const pin = CROSS.frame.toLatLng(3, -1);
  const j = (await get(q({ lat: pin.lat.toFixed(7), lng: pin.lng.toFixed(7), overhangIn: '6' }))).json();
  assert.deepEqual(j.place, { address: null, lat: Number(pin.lat.toFixed(7)), lng: Number(pin.lng.toFixed(7)), precision: 'PIN' });
  const porch = j.segments.find(s => s.lowSlope);
  assert.equal(porch.rise, 1);
  assert.deepEqual(j.attic.excluded, [porch.n]);
  assert.equal(j.attic.excludedM2, porch.groundM2);
  assert.equal(j.attic.overhangM, 0.1524);
  assert.equal(porch.lower, true, 'the porch is a lower roof');
  // The CONTRACT formula from the numbers on the wire gives the same floor, wall run and roof deck.
  const c = contractAttic(j);
  assert.ok(Math.abs(c.floor - j.attic.floorM2) < 0.01);
  assert.ok(Math.abs(c.wallRun - j.attic.wallRunM) <= 0.002, 'wall run');
  assert.ok(Math.abs(c.deck - j.attic.deckM2) < 0.02, 'roof deck');
  near(j.attic.wallRunM / FT, 212 - 32 - 8 * 0.5, 0.02, 'wall run without the porch\'s 32 ft of outline');
  near(j.edgeTotalsM.valley / FT, CROSS.truth.ft.valley, 0.05, 'valleys');
  near(j.edgeTotalsM.headwall / FT, 16, 0.05, 'porch wall');
  assert.ok(j.edgeTotalsM.step < 0.3);
  assert.ok(j.edges.some(e => e.type === 'headwall' && e.faces.includes(porch.n)));
});

test('every mock house: v1.1 fields, the CONTRACT formulas, and accuracy against the drawings', async () => {
  for (const h of HOUSES) {
    const j = (await get(q({ address: h.address.split(',')[0] }))).json();
    assert.equal(j.version, 1, h.id);
    assert.deepEqual(Object.keys(j.attic), ATTIC_KEYS, h.id);
    assert.deepEqual(Object.keys(j.edgeTotalsM), EDGE_TYPES, h.id);
    for (const s of j.segments) assert.deepEqual(Object.keys(s), SEGMENT_KEYS, h.id);
    const c = contractAttic(j);
    assert.ok(Math.abs(c.floor - j.attic.floorM2) < 0.01, `${h.id} floor`);
    assert.ok(Math.abs(c.wallRun - j.attic.wallRunM) <= 0.002, `${h.id} wall run`);
    assert.ok(c.deck == null ? j.attic.deckM2 == null : Math.abs(c.deck - j.attic.deckM2) < 0.02, `${h.id} deck`);
    assert.ok(Math.abs(c.excludedM2 - j.attic.excludedM2) < 0.01, `${h.id} excluded area`);
    assert.ok(Math.abs(c.unmatched - j.attic.unmatchedM2) < 0.01, `${h.id} unmatched`);
    // The outline (for drawing) is what was traced, cut 0.5 m past Google's box; the attic floor's area is always
    // Google's building.
    const outlineTruth = h.truth.cutOutlineFt2 || h.truth.outlineFt2;
    if (outlineTruth) near(j.outline.areaM2 / F2, outlineTruth, 0.02, `${h.id} outline`);
    assert.equal(j.attic.footprintM2, j.building.whole.groundM2, `${h.id} footprint`);
    if (h.truth.attic12Ft2) near(j.attic.floorM2 / F2, h.truth.attic12Ft2, 0.02, `${h.id} attic floor`);
    for (const [k, ft] of Object.entries(h.truth.ft || {})) {
      if (h.id === 'twin' && (k === 'ridge' || k === 'eave')) continue; // these run 0.5 m into the neighbour (see houses.js)
      if (ft > 0) near(j.edgeTotalsM[k] / FT, ft, 0.05, `${h.id} ${k}`);
    }
  }
});

const SCALED = "The traced roof edge doesn't match Google's building size, so the edge length is scaled. Check the attic floor on site.";
const JOINS = "This roof joins a neighbour's. Only this building is measured; check the shared wall on site.";

test('twin: the neighbour\'s roof is cut off at the box, with a warning; a box that takes in both halves is scaled', async () => {
  let j = (await get(q({ address: '5 Twin Ave' }))).json();
  near(j.attic.sharedWallM / FT, 36, 0.03, 'shared wall');
  assert.equal(j.attic.perimeterSource, 'outline');
  near(j.outline.areaM2 / F2, TWIN.truth.cutOutlineFt2, 0.02, 'outline: this half and the 0.5 m allowance');
  // The attic floor: Google's area for this half, the outline's lengths as traced (within 10% of it).
  near(j.attic.footprintM2 / F2, 792, 1e-3, 'footprint: this half');
  assert.equal(j.attic.perimeterM, j.outline.perimeterM);
  near(j.attic.floorM2 / F2, TWIN.truth.attic12Ft2, 0.01, 'attic floor against the true half');
  assert.deepEqual(j.warnings, [JOINS]);
  assert.ok(!j.edges.some(e => e.type === 'rake' && e.planM > 8 && Math.abs(e.path[0].lng - e.path[1].lng) < 2e-6 && e.path[0].lng > j.building.center.lng), 'no rake along the party wall');
  // Google's box takes in both halves: the outline is 2x Google's building. The attic floor keeps Google's size and
  // scales the traced edge length by sqrt(1/2); the outline is still drawn as traced.
  useMock({
    tweakInsights: ins => {
      const b = ins.boundingBox, w = b.ne.longitude - b.sw.longitude;
      return { ...ins, boundingBox: { sw: b.sw, ne: { ...b.ne, longitude: b.ne.longitude + w } } };
    },
  });
  j = (await get(q({ address: '5 Twin Ave' }))).json();
  near(j.outline.areaM2 / F2, 2 * 792, 0.03, 'the outline (still drawn) is both halves');
  assert.equal(j.attic.perimeterSource, 'outline');
  assert.equal(j.attic.footprintM2, j.building.whole.groundM2);
  const k = Math.sqrt(j.building.whole.groundM2 / j.outline.areaM2);
  near(j.attic.perimeterM, j.outline.perimeterM * k, 1e-3, 'edge length scaled');
  assert.equal(j.attic.sharedWallM, 0);
  near(j.attic.floorM2 / F2, TWIN.truth.attic12Ft2, 0.05, 'attic floor still near the true half');
  assert.deepEqual(j.warnings, [SCALED]);
  const c = contractAttic(j);
  assert.ok(Math.abs(c.floor - j.attic.floorM2) < 0.01, 'clients redo it from the wire');
});

test('attached row with a loose box: the attic floor is the building\'s own, not 1.28 x it', async () => {
  const ROW = HOUSES.find(h => h.id === 'row'), tr = ROW.truth;
  const j = (await get(q({ address: '8 Main Row' }))).json();
  near(j.building.whole.groundM2 / F2, 2400, 1e-3, "Google's building");
  near(j.outline.areaM2 / F2, tr.cutOutlineFt2, 0.02, 'the outline as traced (drawn): 1.28 x the building');
  near(j.outline.perimeterM / FT, tr.cutPerimeterFt, 0.02, 'its edge, the cuts included');
  near(j.attic.footprintM2 / F2, 2400, 1e-3, 'footprint: Google\'s building');
  const k = Math.sqrt(j.building.whole.groundM2 / j.outline.areaM2);
  near(j.attic.perimeterM, j.outline.perimeterM * k, 1e-3, 'edge length scaled');
  near(j.attic.sharedWallM / FT, tr.sharedWallFt * k, 0.03, 'both party walls, scaled');
  assert.equal(j.attic.unmatchedM2, 0, 'all of Google\'s building has roof faces');
  near(j.attic.floorM2 / F2, tr.attic12Ft2, 0.01, 'attic floor');
  near(j.attic.floorM2 / F2, 40 * 58, 0.01, 'attic floor against the true middle unit');
  assert.deepEqual(j.warnings, [JOINS, SCALED, 'Mostly flat or low-slope roof. Check whether there is an attic at all.']);
  const c = contractAttic(j);
  assert.ok(Math.abs(c.floor - j.attic.floorM2) < 0.01 && Math.abs(c.wallRun - j.attic.wallRunM) <= 0.002, 'clients redo it from the wire');
});

test('defaults: flat building keeps every face, Cape keeps its dormer and garage, porch out; lower faces marked', async () => {
  let j = (await get(q({ address: '6 Flat Roof Plaza' }))).json();
  assert.deepEqual(j.attic.excluded, []);
  assert.ok(j.segments.every(s => s.lowSlope && !s.lower));
  assert.deepEqual(j.warnings, ['Mostly flat or low-slope roof. Check whether there is an attic at all.']);
  near(j.attic.floorM2 / F2, FLAT.truth.attic12Ft2, 0.01, 'flat attic floor');
  j = (await get(q({ address: '7 Cape Dormer Way' }))).json();
  const by = r => j.segments.filter(s => Math.abs(s.rise - r) < 0.05);
  const [porch] = by(1), [dormer] = by(1.5), garage = by(3);
  assert.deepEqual(j.attic.excluded, [porch.n]);
  assert.equal(dormer.lowSlope, true);
  assert.equal(dormer.lower, false);
  assert.deepEqual(garage.map(s => s.lower), [true, true]);
  assert.equal(porch.lower, true);
  assert.deepEqual(j.segments.filter(s => s.lower).map(s => s.n).sort(), [porch.n, ...garage.map(s => s.n)].sort());
  assert.deepEqual(j.warnings, []);
  near(j.attic.floorM2 / F2, CAPE.truth.attic12Ft2, 0.01, 'Cape attic floor');
  near(j.attic.wallRunM / FT, CAPE.truth.wallRun12Ft, 0.02, 'Cape wall run');
  // Without surface heights the rule falls back to Google's own plane heights, with the same answer.
  useMock({ fail: { dsm: 404 } });
  j = (await get(q({ address: '7 Cape Dormer Way' }))).json();
  assert.deepEqual(j.attic.excluded, [porch.n]);
  assert.deepEqual(j.segments.filter(s => s.lower).map(s => s.n).sort(), [porch.n, ...garage.map(s => s.n)].sort());
  assert.deepEqual(j.attic.perimeterByFaceM, {});
  near(j.attic.wallRunM / FT, CAPE.truth.perimeterFt - 8, 0.02, 'no breakdown: wall run is the whole outline');
});

test('a Solar face that matches nothing in the surface heights gives a warning about short edges', async () => {
  useMock({
    tweakInsights: ins => {
      const s = ins.solarPotential.roofSegmentStats[0];
      const ghost = { ...s, pitchDegrees: 40, azimuthDegrees: 90, planeHeightAtCenterMeters: 20, stats: { ...s.stats, areaMeters2: 30, groundAreaMeters2: 23 } };
      return { ...ins, solarPotential: { ...ins.solarPotential, roofSegmentStats: [...ins.solarPotential.roofSegmentStats, ghost] } };
    },
  });
  const j = (await get(q({ address: '1 Gable Ln' }))).json();
  assert.equal(j.faces.length, 2);
  assert.deepEqual(j.warnings, ['Some roof faces could not be traced (trees or dormers). Edge lengths may be short.']);
});

test('the mask and surface heights download in parallel', async () => {
  const m = useMock({ tiffDelayMs: 60 });
  const r = await get(q({ address: '2 Hip Rd' }));
  assert.equal(r.status, 200);
  assert.equal(m.stats.maxTiffInFlight, 2);
  assert.equal(m.calls.filter(c => c.route === 'geoTiff').length, 2, 'the color photo is not downloaded by the server');
  const j = r.json();
  near(j.edgeTotalsM.hip / FT, 90, 0.05, 'hips');
  near(j.edgeTotalsM.ridge / FT, 20, 0.05, 'ridge');
});

test('bad input is a 400 with a plain message', async () => {
  const cases = [
    [{}, /Enter an address/],
    [{ address: '   ' }, /Enter an address/],
    [{ address: 'x'.repeat(201) }, /too long/],
    [{ lat: 'abc', lng: '-75.75' }, /map pin/],
    [{ lat: '91', lng: '0' }, /map pin/],
    [{ lat: '39.68' }, /map pin/],
    [{ address: '1 Gable Ln', overhangIn: '-1' }, /Overhang/],
    [{ address: '1 Gable Ln', overhangIn: '37' }, /Overhang/],
    [{ address: '1 Gable Ln', overhangIn: 'abc' }, /Overhang/],
    [{ address: '1 Gable Ln', overhangIn: 'Infinity' }, /Overhang/],
  ];
  for (const [params, msg] of cases) {
    const r = await get(q(params));
    assert.equal(r.status, 400, JSON.stringify(params));
    assert.match(r.json().error, msg);
  }
  assert.equal(mock.calls.length, 0, 'nothing reaches Google');
  // Edges of the allowed ranges work.
  assert.equal((await get(q({ address: '  1 Gable Ln  ', overhangIn: '0' }))).json().attic.overhangM, 0);
  assert.equal((await get(q({ address: '1 Gable Ln', overhangIn: '36' }))).json().attic.overhangM, 0.9144);
  assert.equal((await get(q({ address: '1 Gable Ln', overhangIn: '' }))).json().attic.overhangM, 0.3048);
  assert.equal((await get(q({ address: '3 Cross ' + 'x'.repeat(192) }))).status, 200);
});

test('Google errors keep their status and plain message, and never leak the key', async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  let r = await get(q({ address: '1 Gable Ln' }));
  assert.equal(r.status, 500);
  assert.match(r.json().error, /GOOGLE_MAPS_API_KEY/);
  process.env.GOOGLE_MAPS_API_KEY = KEY;

  r = await get(q({ address: '404 Nowhere St' }));
  assert.equal(r.status, 404);
  assert.match(r.json().error, /couldn't find that address/);

  r = await get(q({ address: '12 No Roof Rd' }));
  assert.equal(r.status, 404);
  assert.match(r.json().error, /no roof data/);

  useMock({ fail: { geocode: 403 } });
  r = await get(q({ address: '1 Gable Ln' }));
  assert.equal(r.status, 502);
  assert.match(r.json().error, /Geocoding API/);

  useMock({ fail: { insights: 429 } });
  r = await get(q({ address: '1 Gable Ln' }));
  assert.equal(r.status, 429);

  // A network failure whose error message holds the full request URL, key included.
  useMock({ throwOn: { geocode: true } });
  r = await get(q({ address: '1 Gable Ln' }));
  assert.equal(r.status, 502);
  assert.match(r.json().error, /Couldn't reach Google/);
  assert.ok(logs.some(l => l.includes('key=***')), 'the failure is logged, with the key masked');
});

test('degraded: low-detail imagery with no surface heights still gives the outline and attic floor', async () => {
  const r = await get(q({ address: '4 Low Detail Dr' }));
  assert.equal(r.status, 200);
  const j = r.json();
  assert.equal(j.building.quality, 'LOW');
  assert.equal(j.photo.pixel, 0.5);
  assert.ok(j.outline);
  near(j.outline.areaM2 / F2, 1128, 0.03, 'outline');
  assert.deepEqual([j.faces, j.edges], [[], []]);
  assert.deepEqual(j.edgeTotalsM, Object.fromEntries(EDGE_TYPES.map(k => [k, 0])));
  assert.equal(j.attic.perimeterSource, 'outline');
  assert.equal(j.warnings.length, 3);
  assert.match(j.warnings[0], /Lower-detail imagery/);
  assert.match(j.warnings[1], /cover 83% of the building/);
  assert.match(j.warnings[2], /surface heights didn't load/);
  near(j.attic.unmatchedM2 / F2, 192, 0.05, 'the carport has no roof data');
  assert.deepEqual(j.attic.perimeterByFaceM, {});
});

test('degraded: no measuring photo (data layers 404 or 500)', async () => {
  for (const status of [404, 500]) {
    useMock({ fail: { dataLayers: status } });
    const r = await get(q({ address: '1 Gable Ln' }));
    assert.equal(r.status, 200);
    const j = r.json();
    assert.equal(j.photo, null);
    assert.equal(j.outline, null);
    assert.deepEqual([j.faces, j.edges], [[], []]);
    assert.equal(j.segments.length, 2);
    assert.equal(j.attic.perimeterSource, 'box');
    assert.equal(j.attic.footprintM2, j.building.whole.groundM2);
    near(j.attic.perimeterM / FT, 140, 0.01, 'perimeter from the box');
    near(j.attic.floorM2 / F2, 1064, 0.01, 'attic floor from the box');
    assert.equal(j.warnings.length, 1);
    assert.match(j.warnings[0], status === 404 ? /no measuring photo/ : /didn't load/);
  }
});

test('degraded: mask or surface heights fail, or come in an unexpected projection', async () => {
  useMock({ fail: { mask: 500 } });
  let j = (await get(q({ address: '1 Gable Ln' }))).json();
  assert.equal(j.outline, null);
  assert.deepEqual(j.faces, []);
  assert.equal(j.attic.perimeterSource, 'box');
  assert.match(j.warnings.join(' '), /rooftop outline didn't load/);

  useMock({ fail: { dsm: 404 } });
  j = (await get(q({ address: '1 Gable Ln' }))).json();
  assert.ok(j.outline);
  assert.deepEqual([j.faces, j.edges], [[], []]);
  assert.match(j.warnings.join(' '), /surface heights didn't load/);

  useMock({ throwOn: { dsm: true } });
  j = (await get(q({ address: '1 Gable Ln' }))).json();
  assert.ok(j.outline);
  assert.deepEqual(j.faces, []);

  useMock({ epsg: 4326 });
  j = (await get(q({ address: '1 Gable Ln' }))).json();
  assert.equal(j.outline, null);
  assert.deepEqual(j.faces, []);
  assert.match(j.warnings.join(' '), /map layout/);
  assert.ok(j.photo, 'the photo id still goes to the page');
});

// Koala's two endpoints. A satellite picture of the gable's spot is enough for the auth checks.
const SAT = (() => { const c = GABLE.frame.toLatLng(0, 0); return `/api/satellite?lat=${c.lat.toFixed(7)}&lng=${c.lng.toFixed(7)}&zoom=20`; })();
for (const [name, handler, url] of [['takeoff', takeoff, q({ address: '1 Gable Ln' })], ['satellite', satellite, SAT]]) {
  test(`auth on /api/${name}: with PARTNER_KEY set, only Koala's key gets through`, async () => {
    process.env.PARTNER_KEY = 'partner-secret-123';
    process.env.ACCESS_CODE = 'crew-code';
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-123' })).status, 200);
    // No key, the old crew access code, or a wrong key: refused, and nothing reaches Google.
    const before = mock.calls.length;
    let r = await call(handler, url);
    assert.equal(r.status, 401);
    assert.equal(r.json().error, 'Only the Koala app can use this.');
    r = await call(handler, url, { 'x-access-code': 'crew-code' });
    assert.equal(r.status, 401, 'the old crew code no longer works');
    assert.equal(r.json().error, 'Only the Koala app can use this.');
    for (const wrong of ['wrong-typo', 'partner-secret-12', 'partner-secret-1234', 'x']) {
      r = await call(handler, url, { 'x-partner-key': wrong, 'x-access-code': 'crew-code' });
      assert.equal(r.status, 401, wrong);
      assert.equal(r.json().error, "The partner key doesn't match.");
    }
    // Without ACCESS_CODE it is just as closed.
    delete process.env.ACCESS_CODE;
    assert.equal((await call(handler, url)).status, 401, 'no key while ACCESS_CODE is unset');
    assert.equal(mock.calls.length, before, 'a refused call never reaches Google');
    // A key saved with a trailing newline (echo key | vercel env add) and a padded header both match.
    process.env.PARTNER_KEY = 'partner-secret-123\n';
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-123' })).status, 200);
    assert.equal((await call(handler, url, { 'x-partner-key': '  partner-secret-123 ' })).status, 200);
  });

  test(`auth on /api/${name}: without PARTNER_KEY (local work), ACCESS_CODE or open; any partner key is refused`, async () => {
    // Neither set: open, for the mock and local work.
    assert.equal((await call(handler, url)).status, 200);
    // ACCESS_CODE set: the code is needed.
    process.env.ACCESS_CODE = 'crew-code';
    let r = await call(handler, url);
    assert.equal(r.status, 401);
    assert.match(r.json().error, /access code/);
    assert.equal((await call(handler, url, { 'x-access-code': 'wrong-cod' })).status, 401);
    assert.equal((await call(handler, url, { 'x-access-code': 'crew-code-longer' })).status, 401, 'different length');
    assert.equal((await call(handler, url, { 'x-access-code': 'crew-code' })).status, 200);
    process.env.ACCESS_CODE = ' crew-code\n';
    assert.equal((await call(handler, url, { 'x-access-code': 'crew-code' })).status, 200, 'trimmed');
    // A partner key sent to a server without PARTNER_KEY is a mismatch, even with the right code, so a
    // Koala key with nothing to match shows up at once.
    for (const headers of [{ 'x-partner-key': 'partner-secret-123' }, { 'x-partner-key': 'partner-secret-123', 'x-access-code': 'crew-code' }]) {
      r = await call(handler, url, headers);
      assert.equal(r.status, 401);
      assert.equal(r.json().error, "The partner key doesn't match.");
    }
    delete process.env.ACCESS_CODE;
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-123' })).status, 401);
    // Blank settings count as unset.
    process.env.ACCESS_CODE = '   ';
    process.env.PARTNER_KEY = ' \n';
    assert.equal((await call(handler, url)).status, 200);
  });
}

test('the photo file and the satellite picture come through the mock', async () => {
  const j = (await get(q({ address: '2 Hip Rd' }))).json();
  assert.equal(j.segments.length, 4);
  assert.equal(j.place.address, HIP.address);
  const c = j.building.center;
  const ids = j.photo;
  const tif = await call(geotiff, `/api/geotiff?id=${ids.rgb}`);
  assert.equal(tif.status, 200);
  assert.equal(tif.headers['content-type'], 'image/tiff');
  const img = await (await fromArrayBuffer(tif.buf.buffer.slice(tif.buf.byteOffset, tif.buf.byteOffset + tif.buf.byteLength))).getImage();
  assert.equal(img.getSamplesPerPixel(), 3);
  assert.equal(img.getGeoKeys().ProjectedCSTypeGeoKey, 32618);
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  near(maxX - minX, img.getWidth() * ids.pixel, 1e-9, 'photo width');
  near(maxY - minY, img.getHeight() * ids.pixel, 1e-9, 'photo height');
  const sat = await call(satellite, `/api/satellite?lat=${c.lat}&lng=${c.lng}&zoom=20`);
  assert.equal(sat.status, 200);
  assert.equal(sat.headers['content-type'], 'image/png');
  assert.deepEqual([...sat.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(sat.buf.readUInt32BE(16), 1280);
});
