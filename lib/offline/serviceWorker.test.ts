// public/sw.js run in a stand-in for a service worker (caches, fetch, events), to check which
// cached shell an offline launch opens. The rule that matters: a phone a crew member used last
// never opens someone else's priced /field shell offline.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SW = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'sw.js'), 'utf8');
const ORIGIN = 'http://localhost';

/** A Cache Storage stand-in keyed by path (+ query), enough for sw.js. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const keyOf = (r: string | { url: string }) => {
    const u = new URL(typeof r === 'string' ? r : r.url, ORIGIN);
    return u.pathname + u.search;
  };
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: string | { url: string }) => m.get(keyOf(r))?.clone(),
      put: async (r: string | { url: string }, res: Response) => void m.set(keyOf(r), res),
      delete: async (r: string | { url: string }) => m.delete(keyOf(r)),
      add: async () => undefined,
    };
  };
  return {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async () => undefined,
  };
}

/** Loads sw.js with a network that serves each shell for whoever is signed in. */
function worker() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const net = { online: true, user: 'estimator' as 'estimator' | 'crew' };
  const fetchFn = async (req: string | { url: string }) => {
    if (!net.online) throw new TypeError('Failed to fetch');
    const path = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
    // Crews are sent away from the priced field app; estimators from the crew app.
    const refused = (path === '/field' && net.user === 'crew') || (path === '/crew' && net.user === 'estimator');
    const res = new Response(`<html>${path} for ${net.user}</html>`, { status: refused ? 403 : 200, headers: { 'Content-Type': 'text/html' } });
    return res;
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => void (listeners[type] = fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  };
  new Function('self', 'caches', 'fetch', SW)(self, fakeCaches(), fetchFn);

  /** A navigation as the browser makes it; resolves to the page's text. */
  const go = async (path: string) => {
    let answer: Promise<Response> | null = null;
    listeners.fetch!({ request: { method: 'GET', url: ORIGIN + path, mode: 'navigate' }, respondWith: (p: Promise<Response>) => void (answer = p) });
    const res = await answer!;
    // Let the shell's un-awaited cache writes land.
    await new Promise((r) => setTimeout(r, 0));
    return res.text();
  };
  return { net, go };
}

describe('the service worker offline (public/sw.js)', () => {
  it('opens the cached shell of the person who used the phone last', async () => {
    const w = worker();
    expect(await w.go('/field')).toBe('<html>/field for estimator</html>');
    w.net.online = false;
    expect(await w.go('/field')).toBe('<html>/field for estimator</html>');
  });

  it('opens the crew shell, not the priced field shell, after a crew member used the blower door tool (BD-R4)', async () => {
    const w = worker();
    // An estimator used this phone (and never signed out); then a crew member signs in.
    await w.go('/field');
    w.net.user = 'crew';
    expect(await w.go('/crew')).toBe('<html>/crew for crew</html>');
    expect(await w.go('/field/blower-door?job=0b000000-0000-4000-8000-000000000001')).toBe('<html>/field/blower-door for crew</html>');
    // No signal: the app is launched at /field (the manifest's start_url).
    w.net.online = false;
    expect(await w.go('/field')).toBe('<html>/crew for crew</html>');
    // The blower door tool still opens from its own shell.
    expect(await w.go('/field/blower-door?job=0b000000-0000-4000-8000-000000000001')).toBe('<html>/field/blower-door for crew</html>');
  });
});
