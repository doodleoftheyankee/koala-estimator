'use client';
// The Roof lookup page: the whole roof takeoff for any address, without an estimate. One address box
// (?address= fills it in but never looks it up: each lookup is a paid Google request; "lat,lng", from
// an old Roof Takeoff map-pin link, is looked up as that spot), the same takeoff as the area sheet
// without its Use buttons, the person's recent lookups (opening one shows the saved lookup, no new
// Google call), and "Start an estimate here": a new estimate with the house's address and an Attic
// area that already has this lookup (a roof tapped on the photo too).
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import { db, newLocalEstimate, switchUser, type CachedProfile } from '@/lib/offline/db';
import { fetchRecentLookups, fetchSavedLookup, houseLookup, LookupFailed, seedHouse, showLookup, startRoofLookup } from '@/lib/offline/roofLookup';
import { lookupAddress, NOT_CONFIGURED_MESSAGE, parseLatLng, pitchText, roundSqft, whenText, type LatLng } from '@/lib/roof/lookup';
import { atticFloorNote } from '@/lib/roof/roofing';
import { estimateAddress } from '@/lib/roof/address';
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

/** The house on screen: the store's key for it, what to call it, and its address as typed (none for a spot). */
type Shown = { key: string; label: string; near: string | null };

export function RoofLookupPage({ profile }: { profile: CachedProfile }) {
  const online = useOnline();
  const configured = useRoofConfigured(online);
  const prefill = useAddressParam();
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? prefill;
  const [formError, setFormError] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const t = useTakeoff({ estimateId: null, areaId: null, address: shown?.key ?? '', job: 'attic', near: shown?.near ?? null });

  const lookUp = (e: FormEvent) => {
    e.preventDefault();
    const address = text.replace(/\s+/g, ' ').trim();
    if (address.length < 5 || address.length > 200) {
      setFormError('Type the street and town, or the whole address with the ZIP.');
      return;
    }
    setFormError(null);
    const pin = parseLatLng(address);
    if (pin) {
      // A spot ("lat,lng"): looked up there, like a roof tapped on the photo.
      const key = `Map pin ${pin.lat},${pin.lng}`;
      setShown({ key, label: `the map pin at ${pin.lat}, ${pin.lng}`, near: null });
      startIfNew(key, pin);
      return;
    }
    setShown({ key: address, label: address, near: address });
    // A house already looked up on this page shows again; "Look up again" pays for a new one.
    startIfNew(address, null);
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
            const key = r.tapped ? `${r.label} ${r.id}` : r.label;
            showLookup(null, key, lookup);
            setShown({ key, label: r.label, near: r.tapped ? null : r.label });
            if (!r.tapped) setTyped(r.label);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      </main>

      {t.result && t.last && shown ? <StartBar t={t} typed={shown.near} profile={profile} /> : null}
    </div>
  );
}

/** Looks a typed address (or spot) up unless this page already has (or is getting) it. */
function startIfNew(key: string, pin: LatLng | null) {
  const h = houseLookup(null, key);
  if (!h.running && !h.last) startRoofLookup({ estimateId: null, areaId: null, address: key, pin });
}

/** The two numbers that matter most here: the attic floor and the roof surface. */
function Headline({ t }: { t: Takeoff }) {
  if (!t.f || !t.data || !t.result || !t.houseChoices) return null;
  const tile = (label: string, value: number | null) => (
    <div className="min-w-0 rounded-xl bg-brand-50 px-3 py-2 text-brand-800">
      <div className="text-xs font-bold uppercase tracking-wide">{label}</div>
      {/* The unit wraps under a five-digit number on a narrow phone instead of running out of the tile. */}
      <div className="flex flex-wrap items-baseline gap-x-1 text-3xl font-extrabold tabular-nums">
        <span>{value === null ? '—' : comma(roundSqft(value))}</span>
        {value === null ? null : <span className="text-sm font-semibold">sq ft</span>}
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

/**
 * "Start an estimate here": a new estimate with the house's address and an Attic area that has this
 * lookup. The address is Google's, keeping the typed house number when Google matched only the road;
 * for a roof tapped on the photo, the address the house was first looked up by.
 */
function StartBar({ t, typed, profile }: { t: Takeoff; typed: string | null; profile: CachedProfile }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsed = estimateAddress(t.result?.address ?? t.state.matchedAddress, typed);
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
    <div className="shell-dock z-30 border-t border-slate-200 bg-white/95 px-4 pt-3 backdrop-blur">
      <div className="mx-auto max-w-2xl">
        <Button size="lg" className="w-full" disabled={Boolean(reason) || busy || Boolean(t.state.running)} onClick={start}>
          {busy ? 'Starting…' : 'Start an estimate here'}
        </Button>
        <p className={cx('mt-1 text-center text-xs', reason || error ? 'font-medium text-amber-800' : 'text-slate-500')}>
          {error ?? reason ?? `A new estimate for ${parsed!.street}, ${parsed!.city}, with an Attic area. Its Look up has these numbers: no new charge.`}
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
    // navigator.onLine too: the first render after the page opens offline still says online.
    if (!online || !navigator.onLine) return;
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
