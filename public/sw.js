/* Koala Estimator service worker.
 *
 * Goal: the field app (/field) opens and works with no signal.
 *  - On install, precache the /field shell and every /_next/static asset it references.
 *  - Navigations to /field* : network-first, fall back to the cached shell.
 *  - /_next/static/* and /icons/* : cache-first (file names are content-hashed).
 *  - /api/* and everything else: network only. Offline data lives in IndexedDB, not here.
 * Bump VERSION to force clients onto a new cache.
 */
const VERSION = 'v1';
const SHELL_CACHE = `koala-shell-${VERSION}`;
const STATIC_CACHE = `koala-static-${VERSION}`;
const SHELL_URL = '/field';

async function precacheShell() {
  const cache = await caches.open(SHELL_CACHE);
  const res = await fetch(SHELL_URL, { credentials: 'include', cache: 'no-store' });
  // Signed out or error: skip; the next online visit to /field will cache it.
  if (!res.ok || res.redirected) return;
  await cache.put(SHELL_URL, res.clone());
  const html = await res.text();
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+/g) || [])];
  const staticCache = await caches.open(STATIC_CACHE);
  await Promise.all(
    [...assets, '/manifest.webmanifest', '/icons/icon-192.png'].map((url) =>
      staticCache.add(url).catch(() => undefined),
    ),
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShell().catch(() => undefined).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      for (const key of await caches.keys()) if (!keep.has(key)) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'refresh-shell') event.waitUntil(precacheShell().catch(() => undefined));
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate' && url.pathname.startsWith('/field')) {
    event.respondWith(fieldNavigation(req));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(req));
  }
});

async function fieldNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) {
      cache.put(SHELL_URL, res.clone());
      // Keep the shell's assets cached as deployments change them.
      res
        .clone()
        .text()
        .then(async (html) => {
          const staticCache = await caches.open(STATIC_CACHE);
          const assets = [...new Set(html.match(/\/_next\/static\/[^"'\s)]+/g) || [])];
          for (const a of assets) if (!(await staticCache.match(a))) staticCache.add(a).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    return res;
  } catch {
    const cached = await cache.match(SHELL_URL);
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline</title>' +
        '<body style="font-family:system-ui;padding:2rem;text-align:center"><h1>You are offline</h1>' +
        '<p>Open the Koala Estimator once with signal so it can work offline.</p></body>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 },
    );
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}
