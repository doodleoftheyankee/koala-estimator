// A page that does not exist: branded, with a way on. It stays free of the app shell on purpose:
// the root not-found page is part of every route's client bundle, the public customer quote
// included, so the menu is not loaded here. Sections that call notFound() inside their own shell
// have their own not-found page (app/jobs/not-found.tsx keeps the menu).
// (Signed-out visitors to staff pages are sent to sign in by proxy.ts before they get here.)
import type { Metadata } from 'next';
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
    <div data-register={office ? 'quiet' : undefined}>
      <NotFoundState primary={{ href: home.href, label: `Go to ${home.label}` }} />
    </div>
  );
}
