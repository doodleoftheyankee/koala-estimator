// GET /api/takeoff (and the older endpoints) through the full mock Google path: GeoTIFFs are written by the
// mock and read back by the server, exactly as with Google.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fromArrayBuffer } from 'geotiff';
import takeoff from '../api/takeoff.js';
import lookup from '../api/lookup.js';
import layers from '../api/layers.js';
import geotiff from '../api/geotiff.js';
import satellite from '../api/satellite.js';
import { createMockGoogle } from '../dev/mock-google.js';
import { HOUSES, FT } from '../dev/houses.js';
import { EDGE_TYPES } from '../lib/takeoff.js';

const KEY = 'TEST-KEY-must-never-leak-3f9a';
const F2 = FT * FT;
const [GABLE, HIP, CROSS] = HOUSES;
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
    assert.equal(s.rise, 6);
    assert.equal(s.lowSlope, false);
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
  assert.equal(j.attic.perimeterSource, 'outline');
  assert.deepEqual(j.attic.excluded, []);
  near(j.attic.floorM2 / F2, 1064, 0.02, 'attic floor');
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
  // The CONTRACT formula from the numbers on the wire gives the same floor.
  const { footprintM2: A, perimeterM: P, overhangM: d, excludedM2 } = j.attic;
  assert.ok(Math.abs(Math.max(0, A - P * d + 4 * d * d) * (1 - excludedM2 / A) - j.attic.floorM2) < 0.01);
  assert.ok(Math.abs(j.attic.wallRunM - (P - 8 * d)) <= 0.0005, 'wall run');
  near(j.edgeTotalsM.valley / FT, CROSS.truth.ft.valley, 0.05, 'valleys');
  near(j.edgeTotalsM.step / FT, 16, 0.08, 'porch wall');
  assert.ok(j.edges.some(e => e.type === 'step' && e.faces.includes(porch.n)));
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

for (const [name, handler, url] of [['takeoff', takeoff, q({ address: '1 Gable Ln' })], ['lookup', lookup, '/api/lookup?address=1%20Gable%20Ln']]) {
  test(`auth on /api/${name}: open, access code, partner key`, async () => {
    // Neither set: open, as before.
    assert.equal((await call(handler, url)).status, 200);
    // PARTNER_KEY alone does not lock the tool.
    process.env.PARTNER_KEY = 'partner-secret-123';
    assert.equal((await call(handler, url)).status, 200);
    // ACCESS_CODE set: the code (or the partner key) is needed.
    process.env.ACCESS_CODE = 'crew-code';
    assert.equal((await call(handler, url)).status, 401);
    assert.equal((await call(handler, url, { 'x-access-code': 'wrong-cod' })).status, 401);
    assert.equal((await call(handler, url, { 'x-access-code': 'crew-code-longer' })).status, 401, 'different length');
    assert.equal((await call(handler, url, { 'x-access-code': 'crew-code' })).status, 200);
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-123' })).status, 200);
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-12' })).status, 401);
    assert.equal((await call(handler, url, { 'x-partner-key': 'nope', 'x-access-code': 'crew-code' })).status, 200);
    // ACCESS_CODE without PARTNER_KEY: a partner header alone gets nowhere.
    delete process.env.PARTNER_KEY;
    assert.equal((await call(handler, url, { 'x-partner-key': 'partner-secret-123' })).status, 401);
    const r = await call(handler, url);
    assert.match(r.json().error, /access code/);
  });
}

test('the older endpoints still work through the mock', async () => {
  const lk = (await call(lookup, '/api/lookup?address=2%20Hip%20Rd')).json();
  assert.equal(lk.segments.length, 4);
  assert.equal(lk.place.address, HIP.address);
  const c = lk.building.center;
  const ly = await call(layers, `/api/layers?lat=${c.lat}&lng=${c.lng}&radius=20&pixel=0.1`);
  assert.equal(ly.status, 200);
  const ids = ly.json();
  const tif = await call(geotiff, `/api/geotiff?id=${ids.rgb}`);
  assert.equal(tif.status, 200);
  assert.equal(tif.headers['content-type'], 'image/tiff');
  const img = await (await fromArrayBuffer(tif.buf.buffer.slice(tif.buf.byteOffset, tif.buf.byteOffset + tif.buf.byteLength))).getImage();
  assert.equal(img.getSamplesPerPixel(), 3);
  assert.equal(img.getWidth(), 400);
  assert.equal(img.getGeoKeys().ProjectedCSTypeGeoKey, 32618);
  const [minX, minY, maxX, maxY] = img.getBoundingBox();
  near(maxX - minX, 40, 1e-9, 'photo width');
  near(maxY - minY, 40, 1e-9, 'photo height');
  const sat = await call(satellite, `/api/satellite?lat=${c.lat}&lng=${c.lng}&zoom=20`);
  assert.equal(sat.status, 200);
  assert.equal(sat.headers['content-type'], 'image/png');
  assert.deepEqual([...sat.buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(sat.buf.readUInt32BE(16), 1280);
});
