// A stand-in for Google's Geocoding, Solar and Maps Static APIs, built from the synthetic houses in
// dev/houses.js. Dev and tests only: the dev server installs it as globalThis.ROOF_FETCH when MOCK=1.
// It never touches the network.
//
// Addresses: "1 Gable Ln", "2 Hip Rd", "3 Cross Gable Ct", "4 Low Detail Dr" (LOW quality, its surface-heights
// file fails), "5 Twin Ave" (one half of a twin), "6 Flat Roof Plaza" (commercial, low slope everywhere),
// "7 Cape Dormer Way" (Cape with a shed dormer, an attached garage and a porch), "8 Main Row" (the middle of an
// attached commercial row, with a loose building box). Any other address finds
// 3 Cross Gable Ct. An address containing "404" finds nothing (ZERO_RESULTS); one containing "no roof" lands on
// an empty field, where the Solar API answers 404.

import { HOUSES, EMPTY_FIELD, houseFor, nearestHouse, insightsFor, renderLayers, colorAtLatLng } from './houses.js';
import { encodeGeoTiff } from './tiff.js';
import { encodePng } from './png.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const googleError = (status, message, s) => json(status, { error: { code: status, message, status: s } });
const NATIVE_PIXEL = { HIGH: 0.1, MEDIUM: 0.25, LOW: 0.5 };

const encodeId = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const decodeId = id => { try { return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')); } catch (_) { return null; } };

/**
 * Returns { fetch, calls, stats }. fetch(url, init) answers like Google.
 * opts.fail: { geocode, insights, dataLayers, mask, dsm, rgb, staticmap } -> HTTP status to answer with.
 * opts.throwOn: same names -> throw a network error instead (its message includes the request URL).
 * opts.epsg: projection code written into every GeoTIFF (default: the UTM zone, 32618 here).
 * opts.tiffDelayMs: delay before each GeoTIFF answer (to check that downloads run in parallel).
 * opts.tweakInsights(insights, house): changes the buildingInsights answer (tests: a wrong box, an extra face).
 */
export function createMockGoogle(opts = {}) {
  const fail = opts.fail || {}, throwOn = opts.throwOn || {};
  const calls = [];
  const stats = { tiffInFlight: 0, maxTiffInFlight: 0 };
  const cache = new Map();
  const remember = (k, make) => {
    if (cache.has(k)) return cache.get(k);
    const v = make();
    cache.set(k, v);
    if (cache.size > 16) cache.delete(cache.keys().next().value);
    return v;
  };

  async function mockFetch(input) {
    const url = new URL(String(input));
    const q = url.searchParams, key = q.get('key');
    const route = url.pathname.endsWith('/geocode/json') ? 'geocode'
      : url.pathname.endsWith('buildingInsights:findClosest') ? 'insights'
      : url.pathname.endsWith('dataLayers:get') ? 'dataLayers'
      : url.pathname.endsWith('geoTiff:get') ? 'geoTiff'
      : url.pathname.endsWith('/staticmap') ? 'staticmap' : 'unknown';
    calls.push({ route, url: url.toString() });
    let layer = null;
    if (route === 'geoTiff') layer = (decodeId(q.get('id') || '') || {}).l || null;
    const name = layer || route;
    if (throwOn[name]) throw new TypeError(`fetch failed for ${url.toString()}`);
    if (fail[name]) return googleError(fail[name], `Mock failure for ${name}.`, 'MOCK');
    if (route === 'unknown') return googleError(404, 'Not found.', 'NOT_FOUND');
    if (!key) {
      return route === 'geocode' ? json(200, { status: 'REQUEST_DENIED', error_message: 'You must use an API key.', results: [] })
        : googleError(403, 'The request is missing a valid API key.', 'PERMISSION_DENIED');
    }

    if (route === 'geocode') {
      const address = (q.get('address') || '').trim();
      if (/404/.test(address)) return json(200, { status: 'ZERO_RESULTS', results: [] });
      let loc, formatted, type = 'ROOFTOP';
      if (/no roof/i.test(address)) { loc = EMPTY_FIELD; formatted = `${address}, Newark, DE 19711, USA`; type = 'GEOMETRIC_CENTER'; }
      else {
        const h = houseFor(address);
        loc = h.frame.toLatLng(0.5, -2); // the address point sits near the front of the house
        formatted = h.address;
      }
      return json(200, {
        status: 'OK',
        results: [{ formatted_address: formatted, geometry: { location: { lat: loc.lat, lng: loc.lng }, location_type: type }, place_id: 'mock', types: ['street_address'] }],
      });
    }

    const lat = Number(q.get('location.latitude')), lng = Number(q.get('location.longitude'));
    if (route === 'insights') {
      const h = nearestHouse(lat, lng, 50);
      if (!h) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND');
      const ins = insightsFor(h);
      return json(200, opts.tweakInsights ? opts.tweakInsights(ins, h) : ins);
    }

    if (route === 'dataLayers') {
      const radius = Number(q.get('radiusMeters')), pixel = Number(q.get('pixelSizeMeters') || 0.1);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || !(radius > 0)) return googleError(400, 'Invalid request.', 'INVALID_ARGUMENT');
      const h = nearestHouse(lat, lng, 150);
      const quality = h ? h.quality : 'HIGH';
      const p = Math.max(pixel, NATIVE_PIXEL[quality]);
      const base = { lat, lng, r: radius, p };
      const link = l => `https://solar.googleapis.com/v1/geoTiff:get?id=${encodeId({ ...base, l, ...(l === 'dsm' && h && h.dsmFails ? { gone: 1 } : {}) })}`;
      return json(200, {
        imageryDate: h ? h.imageryDate : { year: 2024, month: 5, day: 14 },
        imageryProcessedDate: { year: 2025, month: 1, day: 10 },
        dsmUrl: link('dsm'), rgbUrl: link('rgb'), maskUrl: link('mask'),
        annualFluxUrl: link('flux'), monthlyFluxUrl: link('flux'),
        imageryQuality: quality,
      });
    }

    if (route === 'geoTiff') {
      const id = decodeId(q.get('id') || '');
      if (!id || !['rgb', 'mask', 'dsm'].includes(id.l)) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND');
      if (id.gone) return googleError(404, 'Requested entity was not found.', 'NOT_FOUND');
      stats.tiffInFlight++; stats.maxTiffInFlight = Math.max(stats.maxTiffInFlight, stats.tiffInFlight);
      try {
        if (opts.tiffDelayMs) await new Promise(r => setTimeout(r, opts.tiffDelayMs));
        const body = remember(`${q.get('id')}|${opts.epsg || ''}`, () => {
          // The surface heights come on a slightly bigger grid than the photo and mask, as a check that
          // nothing assumes the files share one grid.
          const r = renderLayers(id.lat, id.lng, { radius: id.r, pixel: id.p, layers: [id.l], dsmPad: 4 })[id.l];
          return encodeGeoTiff(r, { epsg: opts.epsg, noData: id.l === 'dsm' ? -9999 : undefined });
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'image/tiff' } });
      } finally {
        stats.tiffInFlight--;
      }
    }

    if (route === 'staticmap') {
      const [clat, clng] = (q.get('center') || '').split(',').map(Number), zoom = Number(q.get('zoom'));
      const [sw, sh] = (q.get('size') || '640x640').split('x').map(Number), scale = Number(q.get('scale') || 1);
      if (!Number.isFinite(clat) || !Number.isFinite(clng) || !Number.isInteger(zoom)) return new Response('Bad request', { status: 400, headers: { 'content-type': 'text/plain' } });
      const body = remember(`map|${clat}|${clng}|${zoom}|${sw}|${sh}|${scale}`, () => staticMap(clat, clng, zoom, sw, sh, scale));
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    }
    return googleError(404, 'Not found.', 'NOT_FOUND');
  }

  return { fetch: mockFetch, calls, stats };
}

// A Web Mercator "satellite" picture of the synthetic town, the same layout as Google's static maps.
function staticMap(lat, lng, zoom, w, h, scale) {
  const W = w * scale, H = h * scale, world = 256 * 2 ** zoom;
  const sin = Math.sin(lat * Math.PI / 180);
  const cx = (lng + 180) / 360 * world, cy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * world;
  const rgb = new Uint8Array(W * H * 3);
  const lngs = new Float64Array(W);
  for (let i = 0; i < W; i++) lngs[i] = (cx + (i + 0.5) / scale - w / 2) / world * 360 - 180;
  for (let j = 0; j < H; j++) {
    const n = Math.PI - 2 * Math.PI * (cy + (j + 0.5) / scale - h / 2) / world;
    const la = 180 / Math.PI * Math.atan(Math.sinh(n));
    for (let i = 0; i < W; i++) {
      const c = colorAtLatLng(la, lngs[i]), k = (j * W + i) * 3;
      rgb[k] = c[0]; rgb[k + 1] = c[1]; rgb[k + 2] = c[2];
    }
  }
  return encodePng(W, H, rgb);
}

export const MOCK_ADDRESSES = HOUSES.map(h => h.address);
