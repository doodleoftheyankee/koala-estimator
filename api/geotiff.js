// GET /api/geotiff?id=..
// Downloads one of Google's photo files (GeoTIFF) by id, adding the API key on the server.
import { query, apiKey, requireAccess, sendError, geoTiff } from '../lib/google.js';

export default async function handler(req, res) {
  try {
    requireAccess(req);
    const body = await geoTiff(query(req).get('id') || '', apiKey());
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/tiff');
    res.setHeader('Cache-Control', 'private, max-age=3000'); // Google's file links last one hour
    res.end(body);
  } catch (e) {
    sendError(res, e);
  }
}
