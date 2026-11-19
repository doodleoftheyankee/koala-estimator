// Minimal Supabase gateway for local E2E: /auth/v1/user (JWT check), /rest/v1 -> PostgREST,
// /storage/v1 -> files on disk. Also stands in for the Anthropic Messages API (photo reads) and the
// Roof Takeoff site (satellite lookups). Not for production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { verify } from './jwt.mjs';
const PGRST = process.env.POSTGREST_URL ?? 'http://127.0.0.1:3001';
const STORE = process.env.E2E_STORAGE ?? new URL('./storage/', import.meta.url).pathname;

// What the stand-in AI "sees" in the estimator's attic photo.
const CANNED_READ = {
  summary: 'Attic floor with about 3 inches of settled blown fiberglass between 2x6 joists. Two recessed lights near the hatch may not be IC-rated.',
  spaceSeen: 'attic_floor',
  matchesArea: true,
  existingInsulation: { material: 'Blown fiberglass', depthInches: 3, estimatedRValue: null, condition: 'settled_or_compressed', confidence: 'high', evidence: 'Joist tops show 2 to 3 inches above the fill.' },
  framing: { memberDepthInches: 5.5, spacingInches: 16, confidence: 'medium', evidence: '2x6 ceiling joists at 16 inches on center.' },
  size: { lengthFt: null, widthFt: null, sqftLow: null, sqftHigh: null, confidence: 'low', method: 'No scale reference in the photo.' },
  access: { level: 'difficult', reason: 'Low pitch, about 3 ft at the peak.', confidence: 'medium' },
  removal: { recommended: false, reason: 'Dry and clean; top it up.' },
  hazards: [{ type: 'non_ic_recessed_lights', severity: 'caution', detail: 'Two can lights near the hatch.', photoNumbers: [1] }],
  obstructions: [{ name: 'Bath fan duct', lengthFt: null, widthFt: null, count: 1, subtractFromArea: false, detail: 'Flexible duct across the bays.' }],
  airSealing: ['Top plates along the eaves', 'Plumbing stack'],
  estimatorNotes: ['Needs baffles at every eave bay.'],
  photoTips: ['Stand a tape measure in the insulation.'],
};
const users = JSON.parse(fs.readFileSync(new URL('./users.json', import.meta.url)));

// Roof Takeoff stand-in: the same made-up house the unit tests use (lib/roof/__fixtures__), and Roof
// Takeoff's own answer for its cross-gable mock house, with every kind of roof edge it measures
// (GET /api/takeoff?address=3 Cross Gable Ct on its mock server, kept in __fixtures__/roof-takeoff).
const ROOF_KEY = process.env.ROOF_TAKEOFF_KEY ?? 'e2e-roof-key';
const TAKEOFF = JSON.parse(fs.readFileSync(new URL('../../lib/roof/__fixtures__/takeoff.json', import.meta.url)));
const CROSS_GABLE = JSON.parse(fs.readFileSync(new URL('../../lib/roof/__fixtures__/roof-takeoff/3-cross-gable.json', import.meta.url)));

// A fake aerial photo of that house (1280 x 1280, as Google's 640 x 640 at scale 2): grass, a
// street, and each roof face shaded by the way it faces, placed with the same Web Mercator math.
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const inside = (p, poly) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lng < ((b.lng - a.lng) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lng) hit = !hit;
  }
  return hit;
};
const photos = new Map();
function aerialPhoto(lat, lng, zoom) {
  const id = `${lat},${lng},${zoom}`;
  if (photos.has(id)) return photos.get(id);
  const W = 1280, size = 256 * 2 ** zoom;
  const sin = Math.sin((lat * Math.PI) / 180);
  const cx = ((lng + 180) / 360) * size, cy = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size;
  const shade = { 1: [168, 160, 156], 2: [112, 108, 110], 3: [150, 142, 136], 4: [126, 120, 118], 5: [176, 170, 160] };
  const houses = [TAKEOFF, CROSS_GABLE].filter((h) => Math.abs(h.building.center.lat - lat) < 0.001 && Math.abs(h.building.center.lng - lng) < 0.001);
  const faces = houses.flatMap((h) => h.faces.map((f) => ({ poly: f.poly, rgb: shade[f.n] ?? [140, 140, 140] })));
  const roads = houses.map((h) => h.place.lat - 0.00004);
  const raw = Buffer.alloc((W * 3 + 1) * W);
  for (let y = 0; y < W; y++) {
    raw[y * (W * 3 + 1)] = 0;
    const wy = cy + y / 2 - 320, n = Math.PI - (2 * Math.PI * wy) / size;
    const plat = (180 / Math.PI) * Math.atan(Math.sinh(n));
    for (let x = 0; x < W; x++) {
      const p = { lat: plat, lng: ((cx + x / 2 - 320) / size) * 360 - 180 };
      const noise = ((x * 7919 + y * 104729) ^ (x * y)) % 23;
      let rgb = [70 + noise, 104 + noise, 58 + (noise >> 1)];
      if (roads.some((roadLat) => Math.abs(p.lat - roadLat) < 0.000035)) rgb = [96 + (noise >> 2), 96 + (noise >> 2), 100];
      for (const f of faces) if (inside(p, f.poly)) rgb = f.rgb.map((c) => c + (noise >> 2));
      raw.set(rgb, y * (W * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  photos.set(id, png);
  return png;
}

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

// The e2e flow can make the database unreachable (L36): REST answers 503 as Supabase's gateway does
// when PostgREST cannot be reached, while sign-in keeps working. POST /__e2e/rest {"down": true|false}.
let restDown = false;

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    if (url.pathname === '/__e2e/rest' && req.method === 'POST') {
      restDown = JSON.parse((await readBody(req)).toString() || '{}').down === true;
      return send(res, 200, { down: restDown });
    }
    if (url.pathname === '/auth/v1/user') {
      const claims = verify(auth);
      const u = claims && users.find((x) => x.id === claims.sub);
      if (!u) return send(res, 401, { code: 401, msg: 'invalid JWT' });
      return send(res, 200, { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/auth/v1/')) return send(res, 404, { msg: 'not mocked: ' + url.pathname });

    if (url.pathname.startsWith('/rest/v1')) {
      if (restDown) return send(res, 503, { message: 'An invalid response was received from the upstream server' });
      const body = await readBody(req);
      const headers = { ...req.headers };
      delete headers.host; delete headers['content-length'];
      const r = await fetch(PGRST + url.pathname.replace('/rest/v1', '') + url.search, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
      const buf = Buffer.from(await r.arrayBuffer());
      const out = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) out[k] = v; });
      res.writeHead(r.status, out); return res.end(buf);
    }

    if (url.pathname.startsWith('/storage/v1/object/sign/')) {
      const key = decodeURIComponent(url.pathname.replace('/storage/v1/object/sign/', ''));
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        // createSignedUrls (bulk): POST /object/sign/<bucket> {paths}
        if (Array.isArray(body.paths)) return send(res, 200, body.paths.map((p) => ({ path: p, signedURL: `/object/sign/${key}/${p}?token=t`, error: null })));
        return send(res, 200, { signedURL: `/object/sign/${key}?token=t` });
      }
      const f = path.join(STORE, key);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': key.endsWith('.pdf') ? 'application/pdf' : key.endsWith('.jpg') ? 'image/jpeg' : 'image/png' });
      return res.end(fs.readFileSync(f));
    }
    if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'POST') {
      const key = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''));
      const f = path.join(STORE, key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      let buf = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.startsWith('multipart/form-data')) {
        const boundary = '--' + ct.split('boundary=')[1];
        const s = buf.toString('latin1');
        const parts = s.split(boundary).filter((p) => p.includes('\r\n\r\n') && !p.startsWith('--'));
        const filePart = parts.find((p) => /filename=|name=""/.test(p)) || parts[parts.length - 1];
        const data = filePart.slice(filePart.indexOf('\r\n\r\n') + 4, filePart.lastIndexOf('\r\n'));
        buf = Buffer.from(data, 'latin1');
      }
      fs.writeFileSync(f, buf);
      return send(res, 200, { Key: key, Id: key });
    }
    // Anthropic Messages API stand-in for AI photo reading (ANTHROPIC_BASE_URL points here). Streams
    // a canned read and keeps the last request so the test can check what was sent.
    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString());
      fs.mkdirSync(STORE, { recursive: true });
      fs.writeFileSync(path.join(STORE, 'anthropic-last.json'), JSON.stringify({ headers: { beta: req.headers['anthropic-beta'] ?? null, key: Boolean(req.headers['x-api-key'] || req.headers.authorization) }, body }));
      const text = JSON.stringify(CANNED_READ);
      const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(ev('message_start', { message: { id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 4200, output_tokens: 1 } } }));
      res.write(ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
      res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, 200) } }));
      res.write(ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(200) } }));
      res.write(ev('content_block_stop', { index: 0 }));
      res.write(ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1300 } }));
      res.write(ev('message_stop', {}));
      return res.end();
    }
    // Roof Takeoff stand-in (ROOF_TAKEOFF_URL points here): the partner key is required, as on the
    // real site. Every lookup is counted and the last one kept, so the test can check what was sent
    // and that a saved lookup was used instead of paying again.
    if (url.pathname === '/api/takeoff' || url.pathname === '/api/satellite') {
      if (req.headers['x-partner-key'] !== ROOF_KEY) return send(res, 401, { error: "The partner key doesn't match." });
      if (url.pathname === '/api/satellite') {
        const [lat, lng, zoom] = ['lat', 'lng', 'zoom'].map((k) => Number(url.searchParams.get(k)));
        if (![lat, lng].every(Number.isFinite) || !Number.isInteger(zoom) || zoom < 1 || zoom > 21) return send(res, 400, { error: 'Bad map request.' });
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' });
        return res.end(aerialPhoto(lat, lng, zoom));
      }
      const address = url.searchParams.get('address') ?? '';
      const pin = url.searchParams.has('lat') ? { lat: Number(url.searchParams.get('lat')), lng: Number(url.searchParams.get('lng')) } : null;
      fs.mkdirSync(STORE, { recursive: true });
      fs.writeFileSync(path.join(STORE, 'roof-last.json'), JSON.stringify({ address, pin, key: true }));
      fs.appendFileSync(path.join(STORE, 'roof-calls.log'), JSON.stringify({ address, pin }) + '\n');
      if (/nowhere/i.test(address)) return send(res, 404, { error: "Google couldn't find that address. Check the spelling, or add the town and state." });
      if (/no roof/i.test(address)) return send(res, 404, { error: 'Google has no roof data for this spot. Tap the right roof on the image, or measure it from photos.' });
      await new Promise((r) => setTimeout(r, 1500)); // long enough to see the lookup running
      const answer = structuredClone(/cross gable/i.test(address) ? CROSS_GABLE : TAKEOFF);
      // A spot tapped on the photo: no address, the pin as Google's point.
      if (pin) answer.place = { address: null, lat: pin.lat, lng: pin.lng, precision: 'PIN' };
      // The same house with a carport Google has no roof faces for (contract v1.1 unmatchedM2).
      if (/carport/i.test(address)) Object.assign(answer.attic, { footprintM2: 242, unmatchedM2: 25 });
      // A house with 24 roof faces (dormers, porches, a garage): the report still fits one page.
      if (/many faces/i.test(address)) {
        answer.place.address = '24 Many Faces Ln, Newark, DE 19711, USA';
        const { segments, faces } = answer;
        answer.segments = Array.from({ length: 24 }, (_, i) => ({ ...segments[i % segments.length], n: i + 1 }));
        answer.faces = Array.from({ length: 24 }, (_, i) => ({ ...faces[i % faces.length], n: i + 1 }));
      }
      // An older Roof Takeoff (contract v1): none of the v1.1 additions.
      if (/old rd/i.test(address)) {
        for (const k of ['sharedWallM', 'unmatchedM2', 'perimeterByFaceM', 'deckM2']) delete answer.attic[k];
        answer.attic.wallRunM = 67.1;
        for (const s of answer.segments) delete s.lower;
        delete answer.edgeTotalsM.headwall;
      }
      return send(res, 200, answer);
    }
    // remove: DELETE /object/<bucket> {prefixes}
    if (url.pathname.startsWith('/storage/v1/object/') && req.method === 'DELETE') {
      const bucket = decodeURIComponent(url.pathname.replace('/storage/v1/object/', ''));
      const { prefixes = [] } = JSON.parse((await readBody(req)).toString() || '{}');
      for (const p of prefixes) fs.rmSync(path.join(STORE, bucket, p), { force: true });
      return send(res, 200, prefixes.map((p) => ({ name: p })));
    }
    send(res, 404, { error: 'not mocked: ' + req.method + ' ' + url.pathname });
  } catch (e) {
    console.error(e); send(res, 500, { error: String(e) });
  }
}).listen(Number(process.env.MOCK_PORT ?? 54321), () => console.log(`mock supabase on :${process.env.MOCK_PORT ?? 54321}`));
