// Calls to the Roof Takeoff site, server to server (app/api/roof). Roof Takeoff holds the Google
// key; this app sends only its partner key (x-partner-key), which never reaches the phone. Errors
// become RoofLookupError with a message the estimator can act on. No env access here: the routes
// pass the base URL and key in, so this can be tested with a stand-in fetch.
import { compactTakeoff, LOOKUP_TIMEOUT_MS, takeoffSchema, type RoofResult } from './lookup';

export type RoofErrorCode = 'not_configured' | 'refused' | 'not_found' | 'invalid' | 'busy' | 'timeout' | 'unreachable' | 'bad_response' | 'aborted' | 'failed';

/** A failure the field app can show as-is; `status` is what the app's route answers with. */
export class RoofLookupError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: RoofErrorCode,
  ) {
    super(message);
  }
}

export interface RoofService {
  /** e.g. https://roof-takeoff-ten.vercel.app (no trailing slash) */
  baseUrl: string;
  key: string;
  /** Stand-in for tests. */
  fetch?: typeof fetch;
}

export const NOT_CONFIGURED = "Satellite lookup isn't set up yet. The owner adds the Roof Takeoff key in Vercel (ROOF_TAKEOFF_KEY).";
const REFUSED = 'The lookup service turned us away. Ask the office to check the Roof Takeoff key.';

/** Roof Takeoff's own message, made safe to show: one line, no markup, not too long. */
function theirMessage(body: unknown): string | null {
  const e = body && typeof body === 'object' && 'error' in body ? (body as { error: unknown }).error : null;
  if (typeof e !== 'string') return null;
  const text = e.replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : null;
}

/** Maps a Roof Takeoff error status to what the estimator is told. */
export function errorFor(status: number, body: unknown): RoofLookupError {
  const theirs = theirMessage(body);
  if (status === 401 || status === 403) return new RoofLookupError(REFUSED, 502, 'refused');
  if (status === 404) return new RoofLookupError(theirs ?? "Google couldn't find that address or has no roof data for it. Check the address, or measure by hand.", 404, 'not_found');
  if (status === 400) return new RoofLookupError(theirs ?? "The lookup service couldn't use that address. Check it and try again.", 400, 'invalid');
  if (status === 429) return new RoofLookupError('The lookup service is busy or reached its daily limit. Try again in a few minutes.', 429, 'busy');
  return new RoofLookupError('The lookup service had a problem. Try again in a minute, or measure by hand.', 502, 'failed');
}

/**
 * Calls fn with a signal that ends when the caller gives up (`signal`) or after `timeoutMs`, and
 * turns network failures into RoofLookupErrors (timeout, stopped, unreachable).
 */
async function withDeadline<T>(signal: AbortSignal | undefined, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    return await fn(both);
  } catch (e) {
    if (e instanceof RoofLookupError) throw e;
    if (signal?.aborted) throw new RoofLookupError('Stopped.', 499, 'aborted');
    if (deadline.aborted) throw new RoofLookupError('The lookup took too long. Try again, or measure by hand.', 504, 'timeout');
    console.error('[roof] Roof Takeoff unreachable', e);
    throw new RoofLookupError("Couldn't reach the lookup service. Try again in a minute.", 502, 'unreachable');
  }
}

/** GET /api/takeoff?address= on Roof Takeoff, validated against the contract and made compact. */
export async function fetchTakeoff(address: string, service: RoofService, signal?: AbortSignal, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<RoofResult> {
  const doFetch = service.fetch ?? fetch;
  const url = `${service.baseUrl}/api/takeoff?${new URLSearchParams({ address })}`;
  const { res, body } = await withDeadline(signal, timeoutMs, async (s) => {
    const res = await doFetch(url, { headers: { 'x-partner-key': service.key, accept: 'application/json' }, signal: s, cache: 'no-store' });
    // Reading the body is part of the wait: a stalled answer still hits the deadline.
    const body: unknown = await res.json().catch(() => null);
    return { res, body };
  });
  if (!res.ok) {
    const err = errorFor(res.status, body);
    console.error(`[roof] Roof Takeoff answered ${res.status}: ${theirMessage(body) ?? '(no message)'}`);
    throw err;
  }
  const parsed = takeoffSchema.safeParse(body);
  if (!parsed.success) {
    console.error('[roof] Roof Takeoff answer did not match the contract', parsed.error.issues.slice(0, 5));
    throw new RoofLookupError("The lookup service sent an answer this app can't read. Ask the office to check that both apps are up to date.", 502, 'bad_response');
  }
  return compactTakeoff(parsed.data);
}

const IMAGE_TYPES = /^image\/(png|jpeg|webp|gif)\b/;

/** GET /api/satellite on Roof Takeoff: the aerial photo as a stream, with its content type. */
export async function fetchSatellite(
  q: { lat: number; lng: number; zoom: number },
  service: RoofService,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ body: ReadableStream<Uint8Array>; contentType: string }> {
  const doFetch = service.fetch ?? fetch;
  const url = `${service.baseUrl}/api/satellite?${new URLSearchParams({ lat: String(q.lat), lng: String(q.lng), zoom: String(q.zoom) })}`;
  return withDeadline(signal, timeoutMs, async (s) => {
    const res = await doFetch(url, { headers: { 'x-partner-key': service.key }, signal: s, cache: 'no-store' });
    if (!res.ok) throw errorFor(res.status, await res.json().catch(() => null));
    const contentType = res.headers.get('content-type') ?? '';
    if (!IMAGE_TYPES.test(contentType) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new RoofLookupError("The aerial photo didn't load. Try again.", 502, 'bad_response');
    }
    return { body: res.body, contentType };
  });
}
