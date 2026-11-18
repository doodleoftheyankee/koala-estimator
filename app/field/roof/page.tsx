import type { Metadata } from 'next';
import { phoneProfile, requireRole } from '@/lib/server/auth';
import { RoofLookupPage } from './RoofLookupPage';

export const metadata: Metadata = { title: 'Roof lookup' };

// Roof lookup: the whole roof takeoff for any address, without an estimate (it used to be the
// separate Roof Takeoff site). Part of the field app; the service worker keeps this page so it
// opens with no signal and says the lookup needs one.
export default async function RoofPage() {
  const profile = await requireRole('owner', 'office', 'estimator');
  return <RoofLookupPage profile={phoneProfile(profile)} />;
}
