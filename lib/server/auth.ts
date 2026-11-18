import 'server-only';
import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import type { Role } from '@/lib/pricing';
import {
  LOCATION_COLUMNS,
  LOCATION_COOKIE,
  parseLocation,
  parseMemberships,
  pickMembership,
  type LocationInfo,
  type Membership,
} from '@/lib/locations/location';

export interface SessionProfile {
  userId: string;
  email: string | null;
  /** The person's role in the store they are working in (locationId). */
  role: Role;
  fullName: string;
  /** The store this request works in. Every query and insert is scoped to it. */
  locationId: string;
  location: LocationInfo;
  /** Every store the person works in (more than one shows a store picker). */
  memberships: Membership[];
  /** Read-only access to every store (corporate roll-up). */
  corporate: boolean;
}

/**
 * The signed-in user's active profile in their current store, or null (signed out, deactivated,
 * or not working in any store). Cached for the request.
 */
export const getSessionProfile = cache(async (): Promise<SessionProfile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const [profile, stores] = await Promise.all([
    supabase.from('profiles').select('full_name, active, corporate').eq('id', user.id).maybeSingle(),
    supabase.rpc('my_locations'),
  ]);
  if (!profile.data || !profile.data.active) return null;
  const memberships = parseMemberships(stores.data);
  const chosen = pickMembership(memberships, (await cookies()).get(LOCATION_COOKIE)?.value);
  if (!chosen) return null;
  const { data: row, error } = await supabase.from('locations').select(LOCATION_COLUMNS).eq('id', chosen.locationId).maybeSingle();
  if (error || !row) return null;
  return {
    userId: user.id,
    email: user.email ?? null,
    role: chosen.role,
    fullName: profile.data.full_name as string,
    locationId: chosen.locationId,
    location: parseLocation(row),
    memberships,
    corporate: Boolean(profile.data.corporate),
  };
});

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

/**
 * The caller's role in a given store (a row they are acting on may belong to another of their
 * stores than the one they are working in). Null when they do not work there.
 */
export function roleIn(profile: SessionProfile, locationId: string): Role | null {
  return profile.memberships.find((m) => m.locationId === locationId)?.role ?? null;
}

/** What the offline apps cache about the person and their store (lib/offline/db.ts CachedProfile). */
export function phoneProfile(p: SessionProfile) {
  return {
    userId: p.userId,
    fullName: p.fullName,
    role: p.role,
    locationId: p.locationId,
    locationName: p.location.name,
    town: p.location.shortName,
    state: p.location.state,
    timeZone: p.location.timeZone,
    utilities: p.location.utilities,
    multiStore: p.memberships.length > 1,
  };
}
