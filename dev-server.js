// Local dev server: serves index.html and routes /api/<name> to api/<name>.js, like Vercel does.
//   npm run dev    real Google, with GOOGLE_MAPS_API_KEY (and ACCESS_CODE, PARTNER_KEY) from .env if present
//   npm run mock   synthetic houses, no network, no key needed (see dev/mock-google.js)
// PORT sets the port (default 8787). Dev only: never deployed (.vercelignore).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname, dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.MOCK === '1' || process.argv.includes('--mock');

// KEY=value lines; existing environment variables win.
function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

let mockAddresses = [];
if (MOCK) {
  const { createMockGoogle, MOCK_ADDRESSES } = await import('./dev/mock-google.js');
  globalThis.ROOF_FETCH = createMockGoogle().fetch;
  process.env.GOOGLE_MAPS_API_KEY = 'mock-key-not-a-real-key';
  mockAddresses = MOCK_ADDRESSES;
} else {
  loadEnvFile(join(ROOT, '.env'));
  loadEnvFile(join(ROOT, '.env.local'));
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
// Only what Vercel would serve as static files: no dotfiles, no server code, no dev or test files.
const PRIVATE = new Set(['api', 'lib', 'dev', 'test', 'node_modules', 'dev-server.js', 'package.json', 'package-lock.json', 'vercel.json']);

const handlers = new Map();
async function apiHandler(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = join(ROOT, 'api', `${name}.js`);
  if (!existsSync(file)) return null;
  if (!handlers.has(name)) handlers.set(name, (await import(pathToFileURL(file).href)).default);
  return handlers.get(name);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
  const parts = rel.split('/');
  if (parts.some(p => !p || p.startsWith('.') || p === '..') || PRIVATE.has(parts[0]) || !TYPES[extname(rel)]) return false;
  const file = resolve(ROOT, rel);
  if (!file.startsWith(ROOT + sep)) return false;
  try {
    if (!(await stat(file)).isFile()) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[extname(rel)]);
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : await readFile(file));
    return true;
  } catch (_) {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    const m = pathname.match(/^\/api\/([^/]+?)\/?$/);
    if (m) {
      const handler = await apiHandler(m[1]);
      if (!handler) { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"Not found."}'); return; }
      await handler(req, res);
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && await serveStatic(req, res, pathname)) return;
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); }
    res.end('{"error":"Something went wrong on the server."}');
  }
});

const port = Number(process.env.PORT) || 8787;
server.listen(port, () => {
  console.log(`Roof Takeoff dev server: http://localhost:${port}${MOCK ? '  (mock Google, no network)' : ''}`);
  if (MOCK) console.log(`Mock addresses: ${mockAddresses.join(' | ')}\n  "404" in an address finds nothing; "no roof" finds no building; anything else finds the cross gable.`);
  else if (!process.env.GOOGLE_MAPS_API_KEY) console.log('No GOOGLE_MAPS_API_KEY set (put it in .env). Lookups will fail; try npm run mock.');
});
