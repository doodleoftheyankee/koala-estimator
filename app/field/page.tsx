import type { Metadata } from 'next';
import { requireRole } from '@/lib/server/auth';
import { FieldApp } from './FieldApp';

export const metadata: Metadata = { title: 'Field' };

// The offline-capable estimator app. Everything below this page runs client-side against
// IndexedDB; the service worker caches this page so it opens with no signal.
export default async function FieldPage() {
  const profile = await requireRole('owner', 'office', 'estimator');
  return <FieldApp profile={{ userId: profile.userId, fullName: profile.fullName, role: profile.role }} />;
}
