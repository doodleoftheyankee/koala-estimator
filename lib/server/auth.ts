import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { isPinLoginEmail, shownEmail } from '@/lib/auth/pin';
import type { Role } from '@/lib/pricing';
import { authErrorState, PATH_HEADER, profileReadState, UNREACHABLE_BODY, unreachableHref } from './sessionState';

export interface SessionProfile {
  userId: string;
  /** The person's email; null for a PIN person (their made-up login address is never shown). */
  email: string | null;
  role: Role;
  fullName: string;
  /** Signs in with their name and PIN (lib/auth/pin.ts): their menu offers "Change my PIN". */
  pinLogin: boolean;
}

export type SessionResult = { state: 'ok'; profile: SessionProfile } | { state: 'signed_out' } | { state: 'unreachable' };

/**
 * Who is signed in, and whether Koala could be asked (L36): ok with the active profile, signed out
 * (no session, or no active profile), or unreachable (the sign-in service or the database did not
 * answer). Unreachable is never a way in. Read once per request: the app shell in a section's
 * layout and the page's own requireRole(...) share it.
 */
export const getSessionState = cache(async function getSessionState(): Promise<SessionResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();
    if (!user) return { state: authErrorState(authError) };
    const { data, error, status } = await supabase.from('profiles').select('role, full_name, active').eq('id', user.id).maybeSingle();
    if (error) return { state: profileReadState(status) };
    if (!data || !data.active) return { state: 'signed_out' };
    const pinLogin = isPinLoginEmail(user.email);
    return {
      state: 'ok',
      profile: { userId: user.id, email: shownEmail(user.email), role: data.role as Role, fullName: data.full_name as string, pinLogin },
    };
  } catch {
    // A request that threw instead of answering (no connection at all).
    return { state: 'unreachable' };
  }
});

/** The signed-in user's active profile, or null (signed out, or Koala could not be reached). */
export const getSessionProfile = cache(async function getSessionProfile(): Promise<SessionProfile | null> {
  const s = await getSessionState();
  return s.state === 'ok' ? s.profile : null;
});

/** The path this request opened (set by proxy.ts), for sending people back to it. */
async function currentPath(): Promise<string | null> {
  try {
    return (await headers()).get(PATH_HEADER);
  } catch {
    return null;
  }
}

/** For pages: Koala unreachable goes to /unreachable (never the sign-in page), signed out to /login. */
export async function redirectIfNoSession(s: SessionResult): Promise<SessionProfile> {
  if (s.state === 'unreachable') redirect(unreachableHref(await currentPath()));
  if (s.state !== 'ok') redirect('/login');
  return s.profile;
}

/**
 * For pages: redirect to /login when signed out, or to /unreachable when Koala cannot be reached.
 * When the role is not allowed, go to /no-access, which says whose page it is and links to the
 * role's home (never a silent redirect, AUDIT §6).
 */
export async function requireRole(...roles: Role[]): Promise<SessionProfile> {
  const profile = await redirectIfNoSession(await getSessionState());
  if (roles.length && !roles.includes(profile.role)) redirect(`/no-access?for=${roles.join(',')}`);
  return profile;
}

/** For route handlers: returns the profile, or a 401/403 response, or 503 while Koala cannot be reached. */
export async function authorize(
  ...roles: Role[]
): Promise<{ profile: SessionProfile; error: null } | { profile: null; error: NextResponse }> {
  const s = await getSessionState();
  if (s.state === 'unreachable') return { profile: null, error: NextResponse.json(UNREACHABLE_BODY, { status: 503, headers: { 'Retry-After': '30' } }) };
  if (s.state !== 'ok') return { profile: null, error: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) };
  const { profile } = s;
  if (roles.length && !roles.includes(profile.role)) {
    return { profile: null, error: NextResponse.json({ error: 'Not allowed for your role' }, { status: 403 }) };
  }
  return { profile, error: null };
}
