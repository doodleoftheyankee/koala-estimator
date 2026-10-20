import 'server-only';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/pricing';

export interface SessionProfile {
  userId: string;
  email: string | null;
  role: Role;
  fullName: string;
}

/** The signed-in user's active profile, or null. */
export async function getSessionProfile(): Promise<SessionProfile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from('profiles').select('role, full_name, active').eq('id', user.id).maybeSingle();
  if (!data || !data.active) return null;
  return { userId: user.id, email: user.email ?? null, role: data.role as Role, fullName: data.full_name as string };
}

/** For pages: redirect to /login when signed out, or to / when the role is not allowed. */
export async function requireRole(...roles: Role[]): Promise<SessionProfile> {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login');
  if (roles.length && !roles.includes(profile.role)) redirect('/');
  return profile;
}

/** For route handlers: returns the profile or a 401/403 response. */
export async function authorize(
  ...roles: Role[]
): Promise<{ profile: SessionProfile; error: null } | { profile: null; error: NextResponse }> {
  const profile = await getSessionProfile();
  if (!profile) return { profile: null, error: NextResponse.json({ error: 'Not signed in' }, { status: 401 }) };
  if (roles.length && !roles.includes(profile.role)) {
    return { profile: null, error: NextResponse.json({ error: 'Not allowed for your role' }, { status: 403 }) };
  }
  return { profile, error: null };
}
