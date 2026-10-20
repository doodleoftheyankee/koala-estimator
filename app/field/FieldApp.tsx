'use client';
import { useCallback, useEffect, useState } from 'react';
import { db, switchUser, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { AuthRequiredError, fetchEstimate, syncAll } from '@/lib/offline/sync';
import { newDraft } from '@/lib/sync/draft';
import { Alert } from '@/components/ui';
import { EstimateEditor } from './EstimateEditor';
import { EstimateList } from './EstimateList';
import { useOnline } from './hooks';

type View = { kind: 'list' } | { kind: 'edit'; id: string };

const SYNC_INTERVAL_MS = 60_000;

export function FieldApp({ profile }: { profile: CachedProfile }) {
  const online = useOnline();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [ready, setReady] = useState(false);
  const [signedOut, setSignedOut] = useState(false);

  const runSync = useCallback(() => {
    syncAll(profile.userId).catch((e) => {
      if (e instanceof AuthRequiredError) setSignedOut(true);
      else console.error(e);
    });
  }, [profile.userId]);

  // Views are kept in component state + history.replaceState (not the Next router) so
  // switching screens never needs the network.
  const go = useCallback((v: View) => {
    setView(v);
    const url = v.kind === 'edit' ? `/field?e=${v.id}` : '/field';
    window.history.replaceState(null, '', url);
    window.scrollTo(0, 0);
  }, []);

  const createEstimate = useCallback(async () => {
    const draft = newDraft();
    const now = new Date().toISOString();
    const rec: LocalEstimate = {
      id: draft.id,
      ownerId: profile.userId,
      draft,
      syncState: 'local',
      mutationId: crypto.randomUUID(),
      lastError: null,
      serverDoc: null,
      serverRowVersion: null,
      updatedAt: now,
      syncedAt: null,
    };
    await db().estimates.put(rec);
    go({ kind: 'edit', id: draft.id });
  }, [go, profile.userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await switchUser(profile);
      const params = new URLSearchParams(window.location.search);
      const id = params.get('e');
      if (params.get('new') === '1') await createEstimate();
      else if (id) {
        if (!(await db().estimates.get(id)) && navigator.onLine) await fetchEstimate(id, profile.userId);
        if (!cancelled) setView((await db().estimates.get(id)) ? { kind: 'edit', id } : { kind: 'list' });
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
            Your session expired. Your work is saved on this phone.{' '}
            <a className="font-semibold underline" href="/login?next=/field">
              Sign in again
            </a>{' '}
            to sync it.
          </Alert>
        </div>
      ) : null}
      {view.kind === 'list' ? (
        <EstimateList profile={profile} online={online} onOpen={(id) => go({ kind: 'edit', id })} onNew={createEstimate} onSync={runSync} />
      ) : (
        <EstimateEditor key={view.id} id={view.id} profile={profile} online={online} onBack={() => go({ kind: 'list' })} requestSync={runSync} />
      )}
    </div>
  );
}
