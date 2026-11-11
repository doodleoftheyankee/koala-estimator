// Minimal Supabase gateway for local E2E: /auth/v1/user (JWT check), /rest/v1 -> PostgREST,
// /storage/v1 -> files on disk. Not for production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    if (url.pathname === '/auth/v1/user') {
      const claims = verify(auth);
      const u = claims && users.find((x) => x.id === claims.sub);
      if (!u) return send(res, 401, { code: 401, msg: 'invalid JWT' });
      return send(res, 200, { id: u.id, email: u.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() });
    }
    if (url.pathname.startsWith('/auth/v1/')) return send(res, 404, { msg: 'not mocked: ' + url.pathname });

    if (url.pathname.startsWith('/rest/v1')) {
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
}).listen(54321, () => console.log('mock supabase on :54321'));
