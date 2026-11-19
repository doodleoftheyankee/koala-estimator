// Where pages send staff while Koala's database or sign-in service does not answer (L36, RF-04):
// "Can't reach Koala right now", not the sign-in page. Public (proxy.ts) and reads no data, so it
// opens while the database is down. ?next= is only ever a path on this site (lib/safeNext).
import type { Metadata } from 'next';
import { UnreachableState } from '@/components/shell/StatePages';
import { fallbackAppsFor, phoneAppFor } from '@/lib/offline/phoneCopy';
import { safeNext } from '@/lib/safeNext';

export const metadata: Metadata = { title: 'Can’t reach Koala' };
export const dynamic = 'force-dynamic';

export default async function UnreachablePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const raw = (await searchParams).next;
  const next = safeNext(Array.isArray(raw) ? raw[0] : raw, '/');
  return <UnreachableState next={next} phoneApp={phoneAppFor(next)} fallbacks={fallbackAppsFor(next)} />;
}
