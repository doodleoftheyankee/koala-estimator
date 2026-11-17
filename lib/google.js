// Server-side calls to Google. The API key stays here and never reaches the browser.
import { timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// The local dev server swaps in mock Google responses through this hook.
const getFetch = () => globalThis.ROOF_FETCH || fetch;

export function query(req) {
  return new URL(req.url, 'http://localhost').searchParams;
}

export function apiKey() {
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (!k) throw new HttpError(500, 'The server has no GOOGLE_MAPS_API_KEY set. Add it in the hosting settings, then redeploy.');
  return k;
}

// Constant-time string compare. A different length is a mismatch.
function sameSecret(got, want) {
  if (typeof got !== 'string' || typeof want !== 'string') return false;
  const a = Buffer.from(got), b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A header or setting, trimmed; empty or missing is null. (A key pasted with a trailing newline still matches.)
const trimmed = v => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
};
const header = (req, name) => {
  const v = req.headers && req.headers[name];
  return trimmed(Array.isArray(v) ? v[0] : v);
};

// See CONTRACT.md "Auth". PARTNER_KEY lets the Koala server through. Set ACCESS_CODE on the server so only
// your crew can run lookups (each one costs money). With no ACCESS_CODE the tool stays open, as before.
// A partner key that is sent but doesn't match is refused even then, so a wrong Koala key shows up at once.
export function requireAccess(req) {
  const partner = trimmed(process.env.PARTNER_KEY), code = trimmed(process.env.ACCESS_CODE);
  const sentKey = header(req, 'x-partner-key'), sentCode = header(req, 'x-access-code');
  if (partner && sameSecret(sentKey, partner)) return;
  if (sentKey != null) {
    // The crew's access code still works on its own (CONTRACT.md checks it before the partner key).
    if (code && sameSecret(sentCode, code)) return;
    throw new HttpError(401, "The partner key doesn't match.");
  }
  if (code && !sameSecret(sentCode, code)) throw new HttpError(401, 'This tool needs an access code.');
}

// Strips the API key out of anything that might be logged (URLs inside fetch errors, for example).
export function redact(text) {
  let s = String(text);
  const k = process.env.GOOGLE_MAPS_API_KEY;
  if (k) s = s.split(k).join('***');
  return s.replace(/([?&]key=)[^&\s"']+/g, '$1***');
}

export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function sendError(res, e) {
  if (!e.status) console.error(redact((e && e.stack) || e));
  sendJson(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.' });
}

export function readLatLng(q) {
  if (!q.has('lat') || !q.has('lng')) return null;
  const lat = Number(q.get('lat')), lng = Number(q.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/* ---------- talking to Google ---------- */

async function call(url, what) {
  try {
    return await getFetch()(url, { cache: 'no-store' });
  } catch (e) {
    console.error(`[google] ${what} unreachable: ${redact((e && e.message) || e)}${e && e.cause ? ` (${redact(e.cause.message || e.cause)})` : ''}`);
    throw new HttpError(502, `Couldn't reach Google for the ${what}. Try again in a minute.`);
  }
}

// Turns a Google error into a message a person can act on. The raw message goes to the server log.
async function failure(r, what) {
  const j = await r.json().catch(() => ({}));
  const msg = (j.error && j.error.message) || '';
  console.error(`[google] ${what} failed: HTTP ${r.status} ${redact(msg)}`);
  if (r.status === 404) return new HttpError(404, what === 'roof lookup'
    ? 'Google has no roof data for this spot. Tap the right roof on the image, or measure it from photos.'
    : "Google's photo for this spot isn't available. Look up the address again.");
  if (r.status === 403 || r.status === 401) return new HttpError(502, `Google refused the ${what}. Make sure the Solar API, Geocoding API and Maps Static API are turned on for this key.`);
  if (r.status === 429) return new HttpError(429, 'Google is busy or the daily limit was reached. Try again in a minute.');
  if (r.status === 400) return new HttpError(400, `Google couldn't use that ${what} request.`);
  return new HttpError(502, `Google had a problem with the ${what} (HTTP ${r.status}). Try again in a minute.`);
}

async function getJson(url, what) {
  const r = await call(url, what);
  if (!r.ok) throw await failure(r, what);
  return r.json();
}

export async function geocode(address, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', key);
  const j = await getJson(url, 'address lookup');
  if (j.status === 'ZERO_RESULTS' || (j.status === 'OK' && !(j.results && j.results.length))) {
    throw new HttpError(404, "Google couldn't find that address. Check the spelling, or add the town and state.");
  }
  if (j.status !== 'OK') {
    console.error(`[google] geocode status ${j.status}: ${redact(j.error_message || '')}`);
    if (j.status === 'REQUEST_DENIED') throw new HttpError(502, 'Google refused the address lookup. Make sure the Geocoding API is turned on for this key.');
    if (j.status === 'OVER_QUERY_LIMIT') throw new HttpError(429, 'Google is busy or the daily limit was reached. Try again in a minute.');
    throw new HttpError(502, 'The address lookup failed. Try again in a minute.');
  }
  const top = j.results[0], loc = top.geometry.location;
  return { address: top.formatted_address, lat: loc.lat, lng: loc.lng, precision: top.geometry.location_type };
}

export async function buildingInsights(lat, lng, key) {
  const url = new URL('https://solar.googleapis.com/v1/buildingInsights:findClosest');
  url.searchParams.set('location.latitude', lat.toFixed(7));
  url.searchParams.set('location.longitude', lng.toFixed(7));
  url.searchParams.set('requiredQuality', 'LOW');
  url.searchParams.set('key', key);
  return getJson(url, 'roof lookup');
}

const ll = p => (p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? { lat: p.latitude, lng: p.longitude } : null);
const box = b => (b && ll(b.sw) && ll(b.ne) ? { sw: ll(b.sw), ne: ll(b.ne) } : null);
const stats = s => (s ? { areaM2: s.areaMeters2 || 0, groundM2: s.groundAreaMeters2 || 0 } : null);

// Keeps only what the page needs: each roof face's pitch, direction and areas, biggest first.
export function trimInsights(ins) {
  const sp = ins.solarPotential || {};
  const segments = (sp.roofSegmentStats || [])
    .map(s => ({
      pitchDeg: s.pitchDegrees || 0,
      azimuthDeg: s.azimuthDegrees || 0,
      areaM2: (s.stats && s.stats.areaMeters2) || 0,
      groundM2: (s.stats && s.stats.groundAreaMeters2) || 0,
      center: ll(s.center),
      box: box(s.boundingBox),
      heightM: Number.isFinite(s.planeHeightAtCenterMeters) ? s.planeHeightAtCenterMeters : null,
    }))
    .filter(s => s.areaM2 > 0)
    .sort((a, b) => b.groundM2 - a.groundM2)
    .map((s, i) => ({ n: i + 1, ...s }));
  return {
    building: {
      center: ll(ins.center),
      box: box(ins.boundingBox),
      quality: ins.imageryQuality || null,
      imageryDate: ins.imageryDate || null,
      faces: stats(sp.wholeRoofStats),
      whole: stats(sp.buildingStats),
    },
    segments,
  };
}

const idOf = u => { try { return new URL(u).searchParams.get('id'); } catch (_) { return null; } };

// Google's own aerial photo, rooftop mask and surface heights around the building. Returns file ids.
export async function dataLayers(lat, lng, radius, pixel, key) {
  const url = new URL('https://solar.googleapis.com/v1/dataLayers:get');
  url.searchParams.set('location.latitude', lat.toFixed(7));
  url.searchParams.set('location.longitude', lng.toFixed(7));
  url.searchParams.set('radiusMeters', String(radius));
  url.searchParams.set('view', 'IMAGERY_LAYERS');
  url.searchParams.set('requiredQuality', 'LOW');
  url.searchParams.set('pixelSizeMeters', String(pixel));
  url.searchParams.set('key', key);
  const j = await getJson(url, 'measuring photo');
  const rgb = idOf(j.rgbUrl), mask = idOf(j.maskUrl);
  if (!rgb || !mask) throw new HttpError(404, "Google's measuring photo isn't available here.");
  return { rgb, mask, dsm: idOf(j.dsmUrl), imageryDate: j.imageryDate || null, quality: j.imageryQuality || null, pixel };
}

export async function geoTiff(id, key) {
  if (!/^[A-Za-z0-9_-]{8,1024}$/.test(id)) throw new HttpError(400, 'Bad photo file id.');
  const url = new URL('https://solar.googleapis.com/v1/geoTiff:get');
  url.searchParams.set('id', id);
  url.searchParams.set('key', key);
  const r = await call(url, 'photo file');
  if (!r.ok) throw await failure(r, 'photo file');
  return Buffer.from(await r.arrayBuffer());
}

// A 640x640 satellite image at scale 2 (1280x1280 pixels), centered on the building.
export async function staticMap(lat, lng, zoom, key) {
  const url = new URL('https://maps.googleapis.com/maps/api/staticmap');
  url.searchParams.set('center', `${lat.toFixed(7)},${lng.toFixed(7)}`);
  url.searchParams.set('zoom', String(zoom));
  url.searchParams.set('size', '640x640');
  url.searchParams.set('scale', '2');
  url.searchParams.set('maptype', 'satellite');
  url.searchParams.set('key', key);
  const r = await call(url, 'satellite image');
  const type = r.headers.get('content-type') || '';
  if (!r.ok || !type.startsWith('image/')) {
    const text = await r.text().catch(() => '');
    console.error(`[google] static map failed: HTTP ${r.status} ${redact(text.slice(0, 300))}`);
    if (r.status === 403) throw new HttpError(502, 'Google refused the satellite image. Make sure the Maps Static API is turned on for this key.');
    throw new HttpError(502, 'The satellite image did not load.');
  }
  return { type, body: Buffer.from(await r.arrayBuffer()) };
}
