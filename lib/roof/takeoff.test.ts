import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/takeoff.json';
import { errorFor, fetchSatellite, fetchTakeoff, RoofLookupError, type RoofService } from './takeoff';

const BASE = 'https://roof.example.test';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A stand-in fetch that records each call and answers with `answer`. */
function service(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const svc: RoofService = {
    baseUrl: BASE,
    key: 'partner-123',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return answer(String(input), init ?? {});
    }) as typeof fetch,
  };
  return { svc, calls };
}

/** Waits until the request is aborted, like a server that never answers. */
const hang = (_: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)));

async function failure(p: Promise<unknown>): Promise<RoofLookupError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(RoofLookupError);
  return e as RoofLookupError;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe('fetchTakeoff', () => {
  it('asks Roof Takeoff with the partner key and returns the compact result', async () => {
    const { svc, calls } = service(() => json(200, fixture));
    const r = await fetchTakeoff('12 Elkton Rd, Newark, DE 19711', svc);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/api/takeoff?address=12+Elkton+Rd%2C+Newark%2C+DE+19711`);
    expect(new Headers(calls[0]!.init.headers).get('x-partner-key')).toBe('partner-123');
    expect(r.footprintM2).toBe(217);
    expect(r.segments).toHaveLength(5);
  });

  it('says plainly when Roof Takeoff turns the key away', async () => {
    for (const status of [401, 403]) {
      const { svc } = service(() => json(status, { error: 'This tool needs an access code.' }));
      const e = await failure(fetchTakeoff('12 Elkton Rd', svc));
      expect(e.message).toBe('The lookup service turned us away. Ask the office to check the Roof Takeoff key.');
      expect([e.status, e.code]).toEqual([502, 'refused']);
    }
  });

  it("passes Google's not-found message through", async () => {
    const { svc } = service(() => json(404, { error: "Google couldn't find that address. Check the spelling, or add the town and state." }));
    const e = await failure(fetchTakeoff('1 Nowhere Ln', svc));
    expect(e.message).toBe("Google couldn't find that address. Check the spelling, or add the town and state.");
    expect([e.status, e.code]).toEqual([404, 'not_found']);
    const bare = await failure(fetchTakeoff('1 Nowhere Ln', service(() => new Response('', { status: 404 })).svc));
    expect(bare.message).toMatch(/couldn't find that address or has no roof data/);
  });

  it("says no roof data in this app's terms (Roof Takeoff's own text points to steps this app doesn't have)", async () => {
    const { svc } = service(() => json(404, { error: 'Google has no roof data for this spot. Tap the right roof on the image, or measure it from photos.' }));
    const e = await failure(fetchTakeoff('12 Elkton Rd', svc));
    expect(e.message).toBe('Google has no roof data for this house. Measure it with 📐 Measure this area.');
    expect([e.status, e.code]).toEqual([404, 'not_found']);
  });

  it('looks up a spot on the map by lat and lng', async () => {
    const { svc, calls } = service(() => json(200, { ...fixture, place: { address: null, lat: 39.68347, lng: -75.75039, precision: 'PIN' } }));
    const r = await fetchTakeoff({ lat: 39.68347, lng: -75.75039 }, svc);
    expect(calls[0]!.url).toBe(`${BASE}/api/takeoff?lat=39.68347&lng=-75.75039`);
    expect(new Headers(calls[0]!.init.headers).get('x-partner-key')).toBe('partner-123');
    expect([r.address, r.precision]).toEqual([null, 'PIN']);
  });

  it('maps busy and server problems to plain messages', async () => {
    const busy = await failure(fetchTakeoff('x', service(() => json(429, { error: 'Google is busy' })).svc));
    expect([busy.status, busy.code]).toEqual([429, 'busy']);
    expect(busy.message).toMatch(/busy/);
    const broken = await failure(fetchTakeoff('x', service(() => json(500, { error: 'The server has no GOOGLE_MAPS_API_KEY set.' })).svc));
    expect([broken.status, broken.code]).toEqual([502, 'failed']);
    expect(broken.message).toBe('The lookup service had a problem. Try again in a minute, or measure by hand.');
    const html = await failure(fetchTakeoff('x', service(() => new Response('<html>Bad gateway</html>', { status: 502 })).svc));
    expect(html.code).toBe('failed');
  });

  it("refuses an answer that doesn't match the contract", async () => {
    const e = await failure(fetchTakeoff('x', service(() => json(200, { ...fixture, attic: null })).svc));
    expect([e.status, e.code]).toEqual([502, 'bad_response']);
    const notJson = await failure(fetchTakeoff('x', service(() => new Response('ok', { status: 200 })).svc));
    expect(notJson.code).toBe('bad_response');
  });

  it('gives up after the timeout', async () => {
    const e = await failure(fetchTakeoff('x', service(hang).svc, undefined, 20));
    expect([e.status, e.code]).toEqual([504, 'timeout']);
    expect(e.message).toMatch(/took too long/);
  });

  it('stops when the phone stops waiting', async () => {
    const stop = new AbortController();
    const p = fetchTakeoff('x', service(hang).svc, stop.signal, 10_000);
    stop.abort();
    const e = await failure(p);
    expect(e.code).toBe('aborted');
  });

  it('says when Roof Takeoff cannot be reached', async () => {
    const e = await failure(fetchTakeoff('x', service(() => Promise.reject(new TypeError('fetch failed'))).svc));
    expect([e.status, e.code]).toEqual([502, 'unreachable']);
  });

  it('keeps markup and odd characters out of a passed-through message', () => {
    const e = errorFor(404, { error: '<b>No\nroof</b>  here' });
    expect(e.message).toBe('b No roof /b here');
    expect(errorFor(400, { error: 42 }).message).toMatch(/couldn't use that address/);
  });
});

describe('fetchSatellite', () => {
  it('streams the photo back with its type', async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { svc, calls } = service(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }));
    const img = await fetchSatellite({ lat: 39.6834, lng: -75.7504, zoom: 20 }, svc);
    expect(calls[0]!.url).toBe(`${BASE}/api/satellite?lat=39.6834&lng=-75.7504&zoom=20`);
    expect(new Headers(calls[0]!.init.headers).get('x-partner-key')).toBe('partner-123');
    expect(img.contentType).toBe('image/png');
    expect(new Uint8Array(await new Response(img.body).arrayBuffer())).toEqual(png);
  });

  it('refuses anything that is not an image, and maps errors', async () => {
    const html = await failure(fetchSatellite({ lat: 1, lng: 1, zoom: 18 }, service(() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })).svc));
    expect(html.code).toBe('bad_response');
    const refused = await failure(fetchSatellite({ lat: 1, lng: 1, zoom: 18 }, service(() => json(401, { error: 'no' })).svc));
    expect(refused.code).toBe('refused');
  });
});
