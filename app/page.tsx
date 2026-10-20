import { redirect } from 'next/navigation';
import { requireRole } from '@/lib/server/auth';

export default async function Home() {
  const profile = await requireRole();
  redirect(profile.role === 'crew' ? '/crew' : profile.role === 'estimator' ? '/field' : '/estimates');
}
