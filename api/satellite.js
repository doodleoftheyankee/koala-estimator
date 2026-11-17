// GET /api/satellite?lat=..&lng=..&zoom=..
// Returns a 1280x1280 Google satellite image so the page can show which building was found.
import { HttpError, query, apiKey, requireAccess, sendError, readLatLng, staticMap } from '../lib/google.js';

export default async function handler(req, res) {
  try {
    requireAccess(req);
    const q = query(req);
    const key = apiKey();
    const pin = readLatLng(q);
    const zoom = Number(q.get('zoom'));
    if (!pin || !Number.isInteger(zoom) || zoom < 1 || zoom > 21) throw new HttpError(400, 'Bad map request.');
    const img = await staticMap(pin.lat, pin.lng, zoom, key);
    res.statusCode = 200;
    res.setHeader('Content-Type', img.type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.end(img.body);
  } catch (e) {
    sendError(res, e);
  }
}
