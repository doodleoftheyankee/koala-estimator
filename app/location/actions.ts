'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getSessionProfile } from '@/lib/server/auth';
import { LOCATION_COOKIE } from '@/lib/locations/location';

/** Switches the store a person in several stores is working in, then starts them at home. */
export async function switchLocation(formData: FormData): Promise<void> {
  const profile = await getSessionProfile();
  if (!profile) redirect('/login');
  const id = String(formData.get('locationId') ?? '');
  if (profile.memberships.some((m) => m.locationId === id)) {
    (await cookies()).set(LOCATION_COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 60 * 60 * 24 * 365 });
  }
  redirect('/');
}
