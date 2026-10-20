'use client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { crewDb, switchCrewUser } from '@/lib/offline/crewDb';
import { CrewAuthRequiredError, crewSyncAll, isCrewSyncing, pullJobs, subscribeCrewSync } from '@/lib/offline/crewSync';
import type { CachedProfile } from '@/lib/offline/db';
import { Alert } from '@/components/ui';
import { useOnline } from '@/app/field/hooks';
import { JobDetail } from './JobDetail';
import { JobList } from './JobList';

type View = { kind: 'list' } | { kind: 'job'; id: string };

const SYNC_INTERVAL_MS = 60_000;

export function CrewApp({ profile }: { profile: CachedProfile }) {
  const online = useOnline();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [ready, setReady] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const syncing = useSyncExternalStore(subscribeCrewSync, isCrewSyncing, () => false);

  const onSyncError = useCallback((e: unknown) => {
    if (e instanceof CrewAuthRequiredError) setSignedOut(true);
    else console.error(e);
  }, []);

  const runSync = useCallback(() => {
    crewSyncAll(profile.userId).catch(onSyncError);
  }, [profile.userId, onSyncError]);

  // Views are kept in component state + history.replaceState (not the Next router) so
  // switching screens never needs the network.
  const go = useCallback((v: View) => {
    setView(v);
    window.history.replaceState(null, '', v.kind === 'job' ? `/crew?j=${encodeURIComponent(v.id)}` : '/crew');
    window.scrollTo(0, 0);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await switchCrewUser(profile);
      const id = new URLSearchParams(window.location.search).get('j');
      // The service worker may serve this shell for another app path when offline.
      if (window.location.pathname !== '/crew') window.history.replaceState(null, '', id ? `/crew?j=${encodeURIComponent(id)}` : '/crew');
      if (id) {
        if (!(await crewDb().jobs.get(id)) && navigator.onLine) await pullJobs(profile.userId).catch(onSyncError);
        if (!cancelled) setView((await crewDb().jobs.get(id)) ? { kind: 'job', id } : { kind: 'list' });
      }
      if (!cancelled) setReady(true);
      runSync();
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (online) runSync();
  }, [online, runSync]);

  useEffect(() => {
    const t = setInterval(runSync, SYNC_INTERVAL_MS);
    const onVisible = () => document.visibilityState === 'visible' && runSync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [runSync]);

  if (!ready) return <div className="p-6 text-center text-slate-500">Loading…</div>;

  return (
    <div className="mx-auto min-h-dvh max-w-2xl">
      {signedOut ? (
        <div className="p-3">
          <Alert tone="red">
            Your session expired. Your actuals are saved on this phone.{' '}
            <a className="font-semibold underline" href="/login?next=/crew">
              Sign in again
            </a>{' '}
            to sync them.
          </Alert>
        </div>
      ) : null}
      {view.kind === 'list' ? (
        <JobList profile={profile} online={online} syncing={syncing} onOpen={(id) => go({ kind: 'job', id })} onSync={runSync} />
      ) : (
        <JobDetail key={view.id} id={view.id} profile={profile} online={online} onBack={() => go({ kind: 'list' })} requestSync={runSync} onAuthError={onSyncError} />
      )}
    </div>
  );
}
