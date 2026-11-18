// A page that does not exist: branded, inside the app menu for signed-in staff, with a way on.
// (Signed-out visitors to staff pages are sent to sign in by proxy.ts before they get here.)
import type { Metadata } from 'next';
import { StaffShell } from '@/components/shell/StaffShell';
import { NotFoundState } from '@/components/shell/StatePages';
import { menuFor } from '@/lib/nav';
import { getSessionProfile } from '@/lib/server/auth';

export const metadata: Metadata = { title: 'Page not found' };

export default async function NotFound() {
  const profile = await getSessionProfile().catch(() => null);
  if (!profile) {
    return <NotFoundState hint="Check the link. If someone sent it to you, ask them for a new one." secondary={{ href: '/login', label: 'Staff sign in' }} />;
  }
  const home = menuFor(profile.role).main[0]!;
  // Office roles get the quiet register their own pages use; estimators and crews the field one.
  const office = profile.role === 'owner' || profile.role === 'office';
  return (
    <StaffShell register={office ? 'quiet' : undefined}>
      <NotFoundState primary={{ href: home.href, label: `Go to ${home.label}` }} />
    </StaffShell>
  );
}
