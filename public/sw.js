/* Koala Estimator service worker.
 *
 * Goal: the field app (/field) and the crew app (/crew) open and work with no signal.
 *  - On install, precache each app shell and every /_next/static asset it references. A shell
 *    the user's role cannot open (a redirect) is skipped.
 *  - Navigations to a shell path: network-first, fall back to that cached shell. A crew phone
 *    has no /field shell (crews are redirected away), so an offline launch at /field (the
 *    manifest start_url) falls back to the cached /crew shell. Never the other way round: the
 *    /field shell can show prices, which crews must not see.
 *  - /_next/static/* and /icons/* : cache-first (file names are content-hashed).
 *  - /api/* and everything else: network only. Offline data lives in IndexedDB, not here.
 * Bump VERSION to force clients onto a new cache.
 */
const VERSION = 'v2';
const SHELL_CACHE = `koala-shell-${VERSION}`;
const STATIC_CACHE = `koala-static-${VERSION}`;
const SHELLS = ['/field', '/crew'];
// Offline only: which cached shell may stand in when a shell is missing (price-free shells only).
const FALLBACK = { '/field': '/crew' };

/** The shell a path belongs to ("/crew", "/field/x"), or null. */
function shellFor(pathname) {
  return SHELLS.find((s) => pathname === s || pathname.startsWith(`${s}/`)) || null;
}

function assetsIn(html) {
  return [...new Set(html.match(/\/_next\/static\/[^"'\s)\\]+/g) || [])];
}

async function precacheShell(shellUrl) {
  const res = await fetch(shellUrl, { credentials: 'include', cache: 'no-store' });
  // Signed out, wrong role (redirect) or error: skip; the next online visit caches it.
  if (!res.ok || res.redirected) return;
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(shellUrl, res.clone());
  const staticCache = await caches.open(STATIC_CACHE);
  await Promise.all(
    [...assetsIn(await res.text()), '/manifest.webmanifest', '/icons/icon-192.png'].map((url) =>
      staticCache.add(url).catch(() => undefined),
    ),
  );
}

function precacheShells() {
  return Promise.all(SHELLS.map((s) => precacheShell(s).catch(() => undefined)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheShells().then(() => self.skipWaiting()));
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
  if (event.data === 'refresh-shell') event.waitUntil(precacheShells());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  const shell = req.mode === 'navigate' ? shellFor(url.pathname) : null;
  if (shell) {
    event.respondWith(shellNavigation(req, shell));
    return;
  }
  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(req));
  }
});

async function shellNavigation(req, shell) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok && !res.redirected) {
      cache.put(shell, res.clone());
      // Keep the shell's assets cached as deployments change them.
      res
        .clone()
        .text()
        .then(async (html) => {
          const staticCache = await caches.open(STATIC_CACHE);
          for (const a of assetsIn(html)) if (!(await staticCache.match(a))) staticCache.add(a).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    return res;
  } catch {
    const cached = (await cache.match(shell)) || (FALLBACK[shell] ? await cache.match(FALLBACK[shell]) : undefined);
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
