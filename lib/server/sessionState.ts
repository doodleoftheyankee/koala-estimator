// Signed out, or Koala cannot be reached? (L36, RF-04, UX-05) When the database or the sign-in
// service does not answer, a staff member is NOT signed out: their session is still good, Koala is
// just not there. Treating it as signed out sent everyone to the sign-in page, which looked like
// being logged out and lost the field app. Pure: the proxy, lib/server/auth and their tests use it.
//
// Never a way in: 'unreachable' grants nothing. Pages send the person to /unreachable (which reads
// no data), APIs answer 503, and the field app opens from the phone's own copy.
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import { safeNext } from '@/lib/safeNext';

export type SessionState = 'ok' | 'signed_out' | 'unreachable';

/** The sign-in check failed: was Koala unreachable (no answer, a 5xx), or is the person signed out? */
export function authErrorState(error: unknown): Exclude<SessionState, 'ok'> {
  if (!error) return 'signed_out';
  if (isAuthRetryableFetchError(error)) return 'unreachable';
  const status = (error as { status?: unknown }).status;
  if (typeof status === 'number' && (status === 0 || status >= 500)) return 'unreachable';
  return 'signed_out';
}

/**
 * Reading the signed-in person's profile failed with this HTTP status (0: no answer). A refused
 * token (401, 403) is a sign-out; anything else means the database did not answer properly.
 */
export function profileReadState(status: number): Exclude<SessionState, 'ok'> {
  return status === 401 || status === 403 ? 'signed_out' : 'unreachable';
}

/** Where a page sends someone when Koala cannot be reached: /unreachable, remembering a same-site path. */
export function unreachableHref(next: string | null | undefined): string {
  return `/unreachable?next=${encodeURIComponent(safeNext(next, '/'))}`;
}

/** What an API answers (status 503) while the database cannot be reached. */
export const UNREACHABLE_BODY = { error: 'unreachable', message: "Can't reach Koala right now. Your work is saved. Try again in a minute." } as const;

/** The request header the proxy sets to the path being opened, so a page can send people back to it. */
export const PATH_HEADER = 'x-koala-path';
