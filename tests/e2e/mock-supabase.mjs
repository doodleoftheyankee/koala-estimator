// Minimal Supabase gateway for local E2E: /auth/v1/user (JWT check), /rest/v1 -> PostgREST,
// /storage/v1 -> files on disk. Not for production.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { verify } from './jwt.mjs';
const PGRST = process.env.POSTGREST_URL ?? 'http://127.0.0.1:3001';
const STORE = process.env.E2E_STORAGE ?? new URL('./storage/', import.meta.url).pathname;
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
      if (req.method === 'POST') { await readBody(req); return send(res, 200, { signedURL: `/object/sign/${key}?token=t` }); }
      const f = path.join(STORE, key);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': key.endsWith('.pdf') ? 'application/pdf' : 'image/png' });
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
    send(res, 404, { error: 'not mocked: ' + req.method + ' ' + url.pathname });
  } catch (e) {
    console.error(e); send(res, 500, { error: String(e) });
  }
}).listen(54321, () => console.log('mock supabase on :54321'));
