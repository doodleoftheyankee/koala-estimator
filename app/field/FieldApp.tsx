'use client';
import { useCallback, useEffect, useState } from 'react';
import { db, getMeta, META, newLocalEstimate, switchUser, type CachedProfile } from '@/lib/offline/db';
import { AuthRequiredError, fetchEstimate, syncAll } from '@/lib/offline/sync';
import { newDraft } from '@/lib/sync/draft';
import { menuFor, phoneTabs } from '@/lib/nav';
import { Banner, ButtonLink, LoadingSteps } from '@/components/daymark';
import { useHideTabBar } from '@/components/shell';
import { EstimateEditor } from './EstimateEditor';
import { EstimateList } from './EstimateList';
import { useLive, useOnline } from './hooks';

type View = { kind: 'list' } | { kind: 'edit'; id: string };

const SYNC_INTERVAL_MS = 60_000;

export function FieldApp({ profile }: { profile: CachedProfile }) {
  const online = useOnline();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [ready, setReady] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // A sync the person asked for (Sync now): the header says "Syncing…" until it ends. Background
  // syncs (every minute, on reconnect) stay quiet and only move "Synced 2 min ago" along.
  const [syncing, setSyncing] = useState(false);
  const lastSync = useLive(() => getMeta<string>(META.lastSync), [], null as string | null);
  // An open estimate has its own bottom bar (price, Previous, Next): the menu's tab bar steps aside.
  useHideTabBar(view.kind === 'edit');

  const runSync = useCallback(
    () =>
      syncAll(profile.userId).catch((e) => {
        if (e instanceof AuthRequiredError) setSignedOut(true);
        else console.error(e);
      }),
    [profile.userId],
  );
  const syncNow = useCallback(() => {
    setSyncing(true);
    void runSync().finally(() => setSyncing(false));
  }, [runSync]);

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
    await db().estimates.put(newLocalEstimate(draft, profile.userId));
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
    const t = setInterval(() => runSync(), SYNC_INTERVAL_MS);
    const onVisible = () => document.visibilityState === 'visible' && runSync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [runSync]);

  // The dock offers Roof lookup only when the menu has no Roof lookup tab (an estimator's has one).
  const roofIsTab = phoneTabs(menuFor(profile.role)).some((i) => i.href === '/field/roof');

  return (
    <main className="mx-auto w-full max-w-2xl">
      {!ready ? (
        <div className="px-4 pt-6">
          <LoadingSteps steps={[{ label: 'Opening the estimates on this phone', state: 'doing' }]} />
        </div>
      ) : (
        <>
          {signedOut ? (
            <div className="px-4 pt-4">
              <Banner
                tone="bad"
                title="Your session expired."
                action={
                  <ButtonLink href="/login?next=/field" size="sm" prefetch={false}>
                    Sign in again
                  </ButtonLink>
                }
              >
                Your work is saved on this phone. Sign in again to sync it.
              </Banner>
            </div>
          ) : null}
          {view.kind === 'list' ? (
            <EstimateList
              title={profile.role === 'estimator' ? 'Estimates' : 'Field app'}
              profile={profile}
              online={online}
              syncing={syncing}
              lastSync={lastSync}
              showRoofLookup={!roofIsTab}
              onOpen={(id) => go({ kind: 'edit', id })}
              onNew={createEstimate}
              onSync={syncNow}
            />
          ) : (
            <EstimateEditor key={view.id} id={view.id} profile={profile} online={online} onBack={() => go({ kind: 'list' })} requestSync={runSync} />
          )}
        </>
      )}
    </main>
  );
}
