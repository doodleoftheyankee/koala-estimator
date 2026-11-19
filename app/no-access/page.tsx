// Where requireRole sends a signed-in person who opened a page their role cannot use (an old
// bookmark, a link someone shared): it says whose page it is and links to their own home page.
import type { Metadata } from 'next';
import { NoAccessState } from '@/components/shell/StatePages';
import { menuFor, ROLE_LABELS } from '@/lib/nav';
import type { Role } from '@/lib/pricing';
import { getSessionState, redirectIfNoSession } from '@/lib/server/auth';

export const metadata: Metadata = { title: 'Not in your menu' };

const ROLE_WORDS: Record<Role, string> = { owner: 'the owner', office: 'the office', estimator: 'estimators', crew: 'crews' };

/** "the owner and the office", from the roles the page lets in. */
function whoseWords(roles: Role[]): string | null {
  const words = roles.map((r) => ROLE_WORDS[r]);
  if (words.length === 0) return null;
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export default async function NoAccessPage({ searchParams }: { searchParams: Promise<{ for?: string | string[] }> }) {
  const profile = await redirectIfNoSession(await getSessionState());
  const raw = (await searchParams).for;
  const roles = ((Array.isArray(raw) ? raw[0] : raw) ?? '')
    .split(',')
    .filter((r): r is Role => r in ROLE_LABELS);
  const whose = whoseWords(roles);
  const home = menuFor(profile.role).main[0]!;
  return (
    <NoAccessState
      title={whose ? `This page is for ${whose}` : 'This page is not in your menu'}
      hint={`You are signed in with the ${ROLE_LABELS[profile.role]} role.${profile.role === 'owner' ? '' : ' If you need this page, ask the owner.'}`}
      primary={{ href: home.href, label: `Go to ${home.label}` }}
    />
  );
}
