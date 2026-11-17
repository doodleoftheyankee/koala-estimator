// GET /api/lookup?address=...   or   /api/lookup?lat=..&lng=..
// Finds the building with Google's Solar API and returns each roof face's pitch and area.
import { HttpError, query, apiKey, requireAccess, sendJson, sendError, readLatLng, geocode, buildingInsights, trimInsights } from '../lib/google.js';

export default async function handler(req, res) {
  try {
    requireAccess(req);
    const q = query(req);
    const key = apiKey();
    const address = (q.get('address') || '').trim().slice(0, 200);
    let place;
    if (address) place = await geocode(address, key);
    else {
      const pin = readLatLng(q);
      if (!pin) throw new HttpError(400, 'Enter an address.');
      place = { address: null, ...pin, precision: 'PIN' };
    }
    const insights = await buildingInsights(place.lat, place.lng, key);
    sendJson(res, 200, { place, ...trimInsights(insights) });
  } catch (e) {
    sendError(res, e);
  }
}
