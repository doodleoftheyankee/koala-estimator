import { redirect } from 'next/navigation';
import { roleHome } from '@/lib/nav';
import { requireRole } from '@/lib/server/auth';

export default async function Home() {
  const profile = await requireRole();
  redirect(roleHome(profile.role));
}
