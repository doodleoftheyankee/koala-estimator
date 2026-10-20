import type { Metadata } from 'next';
import { requireRole } from '@/lib/server/auth';
import { CrewApp } from './CrewApp';

export const metadata: Metadata = { title: 'Crew' };

// The offline-capable crew app: assigned jobs, scope, and actuals entry. Everything below this
// page runs client-side against IndexedDB; the service worker caches this page so it opens on a
// job site with no signal.
export default async function CrewPage() {
  const profile = await requireRole('crew', 'owner', 'office');
  return <CrewApp profile={{ userId: profile.userId, fullName: profile.fullName, role: profile.role }} />;
}
