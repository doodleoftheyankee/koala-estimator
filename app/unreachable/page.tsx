// Where pages send staff while Koala's database or sign-in service does not answer (L36, RF-04):
// "Can't reach Koala right now", not the sign-in page. Public (proxy.ts) and reads no data, so it
// opens while the database is down. ?next= is only ever a path on this site (lib/safeNext).
import type { Metadata } from 'next';
import { UnreachableState } from '@/components/shell/StatePages';
import { safeNext } from '@/lib/safeNext';

export const metadata: Metadata = { title: 'Can’t reach Koala' };
export const dynamic = 'force-dynamic';

/** The phone's own copy of the app the person was opening, which works without Koala. */
function phoneAppFor(next: string): { href: string; label: string } | null {
  if (next === '/field' || next.startsWith('/field?') || (next.startsWith('/field/') && !next.startsWith('/field/roof'))) {
    return { href: '/field', label: 'Open the estimates on this phone' };
  }
  if (next === '/crew' || next.startsWith('/crew?') || next.startsWith('/crew/')) return { href: '/crew', label: 'Open the crew app on this phone' };
  return null;
}

export default async function UnreachablePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw, '/');
  return <UnreachableState next={next} phoneApp={phoneAppFor(next)} />;
}
