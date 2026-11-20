import type { Metadata } from 'next';
import { getSessionProfile, requireRole } from '@/lib/server/auth';
import { FieldApp } from './FieldApp';

// The same name the menu gives this page: "Estimates" for an estimator (their everyday list),
// "Field app" for owner and office, whose "Estimates" is the office list (lib/nav.ts).
export async function generateMetadata(): Promise<Metadata> {
  const profile = await getSessionProfile();
  return { title: profile?.role === 'estimator' ? 'Estimates' : 'Field app' };
}

// The offline-capable estimator app. Everything below this page runs client-side against
// IndexedDB; the service worker caches this page so it opens with no signal.
export default async function FieldPage() {
  const profile = await requireRole('owner', 'office', 'estimator');
  return <FieldApp profile={{ userId: profile.userId, fullName: profile.fullName, role: profile.role }} />;
}
