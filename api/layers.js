// GET /api/layers?lat=..&lng=..&radius=..&pixel=..
// Asks Google for its measuring photo and rooftop mask around the building. Returns file ids.
import { HttpError, query, apiKey, requireAccess, sendJson, sendError, readLatLng, dataLayers } from '../lib/google.js';

const PIXELS = [0.1, 0.25, 0.5, 1];

export default async function handler(req, res) {
  try {
    requireAccess(req);
    const q = query(req);
    const key = apiKey();
    const pin = readLatLng(q);
    const radius = Number(q.get('radius'));
    const pixel = Number(q.get('pixel'));
    if (!pin || !PIXELS.includes(pixel) || !(radius >= 5 && radius <= 100)) throw new HttpError(400, 'Bad photo request.');
    // Keep each file well under the hosting limit for one response (about 4.5 MB).
    if ((2 * radius / pixel) ** 2 * 3 > 4e6) throw new HttpError(400, 'Photo area too large at that detail.');
    sendJson(res, 200, await dataLayers(pin.lat, pin.lng, radius, pixel, key));
  } catch (e) {
    sendError(res, e);
  }
}
