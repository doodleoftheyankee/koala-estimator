// GET /api/takeoff?address=...   or   /api/takeoff?lat=..&lng=..     optional &overhangIn=12
// One call does the whole job (see CONTRACT.md): finds the building, reads Google's rooftop mask and surface
// heights on the server, and returns the roof outline, each face's plan shape, the roof edges and the attic floor.
import {
  HttpError, query, apiKey, requireAccess, sendJson, sendError, readLatLng, redact,
  geocode, buildingInsights, trimInsights, dataLayers, geoTiff,
} from '../lib/google.js';
import { measureRoof, atticFloor, layerSize, riseOf } from '../lib/takeoff.js';
import { readGeoTiff } from '../lib/raster.js';

const INCH = 0.0254;
const r7 = v => Math.round(v * 1e7) / 1e7;
const r3 = v => Math.round(v * 1e3) / 1e3;
const r2 = v => Math.round(v * 1e2) / 1e2;
const ll = p => (p ? { lat: r7(p.lat), lng: r7(p.lng) } : null);
const box = b => (b ? { sw: ll(b.sw), ne: ll(b.ne) } : null);
const stats = s => (s ? { areaM2: r2(s.areaM2), groundM2: r2(s.groundM2) } : null);

function readInput(q) {
  let address = null, pin = null;
  const raw = q.get('address');
  if (raw != null && raw.trim()) {
    address = raw.trim();
    if (address.length > 200) throw new HttpError(400, 'That address is too long. Use 200 characters or fewer.');
  } else if (q.has('lat') || q.has('lng')) {
    pin = readLatLng(q);
    if (!pin) throw new HttpError(400, "That map pin isn't a real spot. Send lat and lng in degrees.");
  } else {
    throw new HttpError(400, 'Enter an address.');
  }
  let overhangIn = 12;
  const o = q.get('overhangIn');
  if (o != null && o.trim() !== '') {
    overhangIn = Number(o);
    if (!Number.isFinite(overhangIn) || overhangIn < 0 || overhangIn > 36) throw new HttpError(400, 'Overhang must be a number of inches from 0 to 36.');
  }
  return { address, pin, overhangIn };
}

async function loadRaster(id, key) {
  if (!id) throw new HttpError(404, 'No file.');
  return readGeoTiff(await geoTiff(id, key));
}

const why = e => redact((e && e.message) || e);

export default async function handler(req, res) {
  try {
    requireAccess(req);
    const input = readInput(query(req));
    const key = apiKey();
    const place = input.address ? await geocode(input.address, key) : { address: null, ...input.pin, precision: 'PIN' };
    const trimmed = trimInsights(await buildingInsights(place.lat, place.lng, key));
    const b = trimmed.building;
    const building = {
      center: ll(b.center), box: box(b.box), quality: b.quality, imageryDate: b.imageryDate,
      faces: stats(b.faces), whole: stats(b.whole),
    };
    const segments = trimmed.segments.map(s => {
      const rise = riseOf(s.pitchDeg);
      return {
        n: s.n, pitchDeg: r2(s.pitchDeg), azimuthDeg: r2(s.azimuthDeg), areaM2: r2(s.areaM2), groundM2: r2(s.groundM2),
        center: ll(s.center), box: box(s.box), heightM: s.heightM == null ? null : r3(s.heightM),
        rise, lowSlope: rise < 2,
      };
    });
    const warnings = [];
    if (b.quality === 'LOW') warnings.push('Lower-detail imagery. Check the pitch on site.');
    if (!segments.length) warnings.push('Google found the building but no roof faces on it. Measure this one on site.');
    if (b.whole && b.whole.groundM2 > 0 && b.faces && b.faces.groundM2 / b.whole.groundM2 < 0.9) {
      warnings.push(`Google's roof faces cover ${Math.round(b.faces.groundM2 / b.whole.groundM2 * 100)}% of the building. The rest has no pitch data (often small or flat parts), so measure it on site.`);
    }

    // Google's measuring photo: the color photo stays in the browser; the mask and heights are read here.
    const center = building.center || { lat: place.lat, lng: place.lng };
    const { radius, pixel } = layerSize(b, center);
    let layers = null, mask = null, dsm = null;
    try {
      layers = await dataLayers(center.lat, center.lng, radius, pixel, key);
    } catch (e) {
      console.error(`[takeoff] measuring photo unavailable: ${why(e)}`);
      warnings.push(e.status === 404
        ? "Google has no measuring photo for this spot, so the roof outline and edges aren't measured. The attic floor uses Google's building size."
        : "Google's measuring photo didn't load, so the roof outline and edges aren't measured. The attic floor uses Google's building size. Try again in a minute.");
    }
    if (layers) {
      const [m, d] = await Promise.allSettled([loadRaster(layers.mask, key), loadRaster(layers.dsm, key)]);
      let oddLayout = false;
      if (m.status === 'fulfilled' && m.value.zone) mask = m.value;
      else if (m.status === 'fulfilled') oddLayout = true;
      else {
        console.error(`[takeoff] rooftop mask unavailable: ${why(m.reason)}`);
        warnings.push("Google's rooftop outline didn't load, so the roof outline isn't measured. The attic floor uses Google's building size.");
      }
      if (d.status === 'fulfilled' && d.value.zone) dsm = d.value;
      else if (d.status === 'fulfilled') oddLayout = true;
      else {
        console.error(`[takeoff] surface heights unavailable: ${why(d.reason)}`);
        warnings.push("Google's surface heights didn't load, so the roof faces and edges (ridges, valleys, eaves) aren't measured.");
      }
      if (oddLayout) warnings.push("Google's files for this spot use a map layout this tool can't read, so some measurements are missing.");
    }

    const measured = measureRoof({ segments, center, mask, dsm });
    if (mask && !measured.outline) warnings.push("Couldn't find this roof's outline on Google's photo. The attic floor uses Google's building size.");
    if (measured.outline && dsm && segments.length && !measured.faces.length) warnings.push("Couldn't match Google's roof faces to the surface heights, so the edges aren't measured.");

    const attic = atticFloor({ building, segments, outline: measured.outline, overhangM: Math.round(input.overhangIn * INCH * 1e6) / 1e6 });

    sendJson(res, 200, {
      version: 1,
      place: { address: place.address, lat: r7(place.lat), lng: r7(place.lng), precision: place.precision || null },
      building,
      segments,
      photo: layers ? { rgb: layers.rgb, imageryDate: layers.imageryDate, pixel: layers.pixel, quality: layers.quality } : null,
      outline: measured.outline,
      faces: measured.faces,
      edges: measured.edges,
      edgeTotalsM: measured.edgeTotalsM,
      attic,
      warnings,
    });
  } catch (e) {
    sendError(res, e);
  }
}
