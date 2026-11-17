'use client';
// The Roof lookup page: the whole roof takeoff for any address, without an estimate. One address box
// (?address= fills it in but never looks it up: each lookup is a paid Google request), the same
// takeoff as the area sheet without its Use buttons, the person's recent lookups (opening one shows
// the saved lookup, no new Google call), and "Start an estimate here": a new estimate with the
// address Google matched and an Attic area that already has this lookup.
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { db, newLocalEstimate, switchUser, type CachedProfile } from '@/lib/offline/db';
import { fetchRecentLookups, fetchSavedLookup, houseLookup, LookupFailed, seedHouse, showLookup, startRoofLookup } from '@/lib/offline/roofLookup';
import { lookupAddress, NOT_CONFIGURED_MESSAGE, pitchText, roundSqft, whenText } from '@/lib/roof/lookup';
import { atticFloorNote } from '@/lib/roof/roofing';
import { parseUsAddress } from '@/lib/roof/address';
import type { RecentLookup } from '@/lib/roof/recent';
import { newArea, newDraft } from '@/lib/sync/draft';
import { Alert, Button, Card, cx, Field, Input } from '@/components/ui';
import { useOnline } from '../hooks';
import { comma, TakeoffBody, useTakeoff, type Takeoff } from '../measure/RoofTakeoff';
import { useRoofConfigured } from '../measure/RoofLookup';

const noSubscribe = () => () => undefined;
/** The address from ?address= (trimmed, at most 200 characters), once on the phone. */
function useAddressParam(): string {
  const search = useSyncExternalStore(
    noSubscribe,
    () => window.location.search,
    () => '',
  );
  return useMemo(() => (new URLSearchParams(search).get('address') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200), [search]);
}

/** The house on screen: the store's key for it and what to call it. */
type Shown = { key: string; label: string };

export function RoofLookupPage({ profile }: { profile: CachedProfile }) {
  const online = useOnline();
  const configured = useRoofConfigured(online);
  const prefill = useAddressParam();
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? prefill;
  const [formError, setFormError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const t = useTakeoff({ estimateId: null, areaId: null, address: shown?.key ?? '', job: 'attic' });

  const lookUp = (e: FormEvent) => {
    e.preventDefault();
    const address = text.replace(/\s+/g, ' ').trim();
    if (address.length < 5 || address.length > 200) {
      setFormError('Type the street and town, or the whole address with the ZIP.');
      return;
    }
    setFormError(null);
    setShown({ key: address, label: address });
    // A house already looked up on this page shows again; "Look up again" pays for a new one.
    startIfNew(address);
  };

  return (
    <div className="mx-auto min-h-dvh max-w-2xl pb-32">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 px-4 py-3 backdrop-blur" style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top))' }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-lg font-bold">🛰️ Roof lookup</h1>
            <p className="text-xs text-slate-500">
              {profile.fullName} · <span className={online ? 'text-emerald-700' : 'text-amber-700'}>{online ? 'Online' : 'Offline'}</span>
            </p>
          </div>
          <a href="/field" className="inline-flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-brand-800 hover:bg-brand-50">
            ← Estimates
          </a>
        </div>
      </header>

      <main className="space-y-4 p-4">
        {!online ? (
          <div role="alert">
            <Alert tone="amber">No signal. The roof lookup needs internet. Your estimates still work offline.</Alert>
          </div>
        ) : !configured ? (
          <Alert tone="amber">{NOT_CONFIGURED_MESSAGE}</Alert>
        ) : null}

        <Card>
          <form onSubmit={lookUp} className="space-y-3" noValidate>
            <Field label="Address" hint="Each lookup is a paid Google request. A house looked up in the last day comes back free." error={formError}>
              <Input
                value={text}
                onChange={(e) => setTyped(e.target.value)}
                type="text"
                autoComplete="street-address"
                enterKeyHint="search"
                maxLength={200}
                placeholder="12 Main St, Newark, DE 19711"
              />
            </Field>
            <Button type="submit" size="lg" className="w-full" disabled={!online || !configured || Boolean(t.state.running)}>
              Look up
            </Button>
          </form>
        </Card>

        {shown ? (
          <>
            <Headline t={t} />
            <TakeoffBody t={t} mode="page" label={shown.label} />
          </>
        ) : null}

        <RecentCard
          online={online}
          owner={profile.role === 'owner'}
          refreshKey={t.last?.lookupId ?? ''}
          onOpen={(r, lookup) => {
            const key = r.label === 'Roof tapped on the photo' ? `${r.label} ${r.id}` : r.label;
            showLookup(null, key, lookup);
            setShown({ key, label: r.label });
            if (r.label !== 'Roof tapped on the photo') setTyped(r.label);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      </main>

      {t.result && t.last && shown ? <StartBar t={t} profile={profile} /> : null}
    </div>
  );
}

/** Looks a typed address up unless this page already has (or is getting) it. */
function startIfNew(address: string) {
  const h = houseLookup(null, address);
  if (!h.running && !h.last) startRoofLookup({ estimateId: null, areaId: null, address });
}

/** The two numbers that matter most here: the attic floor and the roof surface. */
function Headline({ t }: { t: Takeoff }) {
  if (!t.f || !t.data || !t.result || !t.houseChoices) return null;
  const tile = (label: string, value: number | null) => (
    <div className="min-w-0 rounded-xl bg-brand-50 px-3 py-2 text-brand-800">
      <div className="text-xs font-bold uppercase tracking-wide">{label}</div>
      <div className="whitespace-nowrap text-3xl font-extrabold tabular-nums">
        {value === null ? '—' : comma(roundSqft(value))}
        {value === null ? null : <span className="ml-1 text-sm font-semibold">sq ft</span>}
      </div>
    </div>
  );
  return (
    <Card className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {tile('Attic floor', t.f.floorSqft)}
        {tile('Roof surface', t.data.roofSqft)}
      </div>
      <p className="text-xs leading-snug text-slate-600">
        Attic floor: {atticFloorNote(t.result, t.houseChoices)} Roof surface: every face along the slope, overhangs included.
      </p>
    </Card>
  );
}

/** "Start an estimate here": a new estimate with the address Google matched and an Attic area that has this lookup. */
function StartBar({ t, profile }: { t: Takeoff; profile: CachedProfile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseUsAddress(t.result?.address);
  const reason = !parsed
    ? t.result?.address
      ? "Google's address for this roof isn't a full street address. Start the estimate from the estimate list."
      : 'Google gave no street address for the roof you tapped. Start the estimate from the estimate list.'
    : t.needsConfirm
      ? 'Check the house on the photo first: tap “Yes, this is the house”.'
      : null;
  const start = async () => {
    if (!parsed || !t.last || reason) return;
    setBusy(true);
    setError(null);
    try {
      const draft = newDraft();
      draft.property = { ...draft.property, ...parsed };
      draft.areas = [newArea('attic')];
      await switchUser(profile);
      await db().estimates.put(newLocalEstimate(draft, profile.userId));
      seedHouse({
        estimateId: draft.id,
        address: lookupAddress(parsed)!,
        lookup: t.last,
        overhangIn: t.state.overhangIn,
        faces: t.state.faces,
        confirmed: t.state.confirmed,
        wastePct: t.state.wastePct,
      });
      // A full page load: the field app opens an estimate from ?e= when it starts.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/field?e=${draft.id}`);
    } catch (e) {
      console.error('[roof] could not start the estimate', e);
      setError("Couldn't start the estimate on this phone. Try again.");
      setBusy(false);
    }
  };
  return (
    <div className="safe-bottom fixed inset-x-0 bottom-0 z-20 border-t border-slate-200 bg-white/95 px-4 pt-3 backdrop-blur">
      <div className="mx-auto max-w-2xl">
        <Button size="lg" className="w-full" disabled={Boolean(reason) || busy || Boolean(t.state.running)} onClick={start}>
          {busy ? 'Starting…' : 'Start an estimate here'}
        </Button>
        <p className={cx('mt-1 text-center text-xs', reason || error ? 'font-medium text-amber-800' : 'text-slate-500')}>
          {error ?? reason ?? `A new estimate for ${parsed!.street}, ${parsed!.city}, with an Attic area.`}
        </p>
      </div>
    </div>
  );
}

/** The recent lookups (the owner sees everyone's). Opening one shows it as it was saved: no new Google call. */
function RecentCard({ online, owner, refreshKey, onOpen }: { online: boolean; owner: boolean; refreshKey: string; onOpen: (r: RecentLookup, lookup: Awaited<ReturnType<typeof fetchSavedLookup>>) => void }) {
  const [list, setList] = useState<{ items: RecentLookup[]; error: string | null } | null>(null);
  const [opening, setOpening] = useState<{ id: string; error: string | null } | null>(null);
  useEffect(() => {
    if (!online) return;
    let live = true;
    fetchRecentLookups().then(
      (items) => live && setList({ items, error: null }),
      (e: unknown) => live && setList((prev) => ({ items: prev?.items ?? [], error: e instanceof LookupFailed ? e.message : "Couldn't load the recent lookups." })),
    );
    return () => {
      live = false;
    };
  }, [online, refreshKey]);

  const open = async (r: RecentLookup) => {
    setOpening({ id: r.id, error: null });
    try {
      onOpen(r, await fetchSavedLookup(r.id));
      setOpening(null);
    } catch (e) {
      setOpening({ id: r.id, error: e instanceof LookupFailed ? e.message : "Couldn't open that lookup. Try again." });
    }
  };

  return (
    <Card>
      <h2 className="font-semibold">Recent lookups</h2>
      <p className="text-xs text-slate-500">{owner ? "Everyone's lookups. " : ''}Opening one shows it as it was saved: no new charge.</p>
      {!online ? (
        <p className="mt-2 text-sm text-slate-600">Recent lookups need a connection.</p>
      ) : !list ? (
        <p className="mt-2 text-sm text-slate-600">Loading…</p>
      ) : list.error && !list.items.length ? (
        <p className="mt-2 text-sm text-red-700">{list.error}</p>
      ) : !list.items.length ? (
        <p className="mt-2 text-sm text-slate-600">No lookups yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-100">
          {list.items.map((r) => {
            const numbers = [
              r.atticFloorSqft !== null ? `attic floor ${comma(roundSqft(r.atticFloorSqft))} sq ft` : null,
              r.roofSqft !== null ? `roof ${comma(roundSqft(r.roofSqft))} sq ft` : null,
              r.mainPitch !== null ? pitchText(r.mainPitch) : null,
            ].filter(Boolean);
            return (
              <li key={r.id}>
                <button type="button" onClick={() => open(r)} disabled={opening?.id === r.id && !opening.error} className="block min-h-12 w-full py-2.5 text-left active:bg-slate-50 disabled:opacity-60">
                  <span className="block truncate font-semibold">{r.label}</span>
                  <span className="block text-xs text-slate-600">
                    {whenText(new Date(r.lookedUpAt))}
                    {r.by ? ` · by ${r.by}` : ''}
                  </span>
                  {numbers.length ? <span className="block text-xs text-slate-500">{numbers.join(' · ')}</span> : null}
                  {opening?.id === r.id ? <span className={cx('block text-xs', opening.error ? 'text-red-700' : 'text-slate-600')}>{opening.error ?? 'Opening…'}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
