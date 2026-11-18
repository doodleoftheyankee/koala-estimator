'use client';
// The Roof lookup page: the whole roof takeoff for any address, without an estimate, in the
// Daymark field register. One address box (?address= fills it in but never looks it up; "lat,lng",
// from an old Roof Takeoff map-pin link, is looked up as that spot), then the same parts as the
// area sheet in this page's own layout (the photo and the house check first, then the attic floor
// and roof deck, beside each other on a desktop), the recent lookups (opening one shows the saved
// lookup, no new Google call; a roof tapped on the photo is titled by the house it is near), and
// "Start an estimate here" in the dock: a new estimate with the house's address and an Attic area
// that already has this lookup (a roof tapped on the photo too).
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { db, newLocalEstimate, switchUser, type CachedProfile } from '@/lib/offline/db';
import { fetchRecentLookups, fetchSavedLookup, houseLookup, LookupFailed, seedHouse, showLookup, startRoofLookup } from '@/lib/offline/roofLookup';
import { lookupAddress, NOT_CONFIGURED_MESSAGE, parseLatLng, pitchText, roundSqft, whenText, type LatLng } from '@/lib/roof/lookup';
import { atticFloorNote } from '@/lib/roof/roofing';
import { estimateAddress } from '@/lib/roof/address';
import type { RecentLookup } from '@/lib/roof/recent';
import { newArea, newDraft } from '@/lib/sync/draft';
import { num } from '@/lib/format';
import { Banner, Button, Card, CloudOff, cx, Field, House, HousePlus, Icon, Input, LoaderCircle, Satellite, Search, SignLabel } from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { useOnline } from '../hooks';
import { sqftValue, TakeoffBody, TakeoffDock, useTakeoff, type Takeoff } from '../measure/RoofTakeoff';
import { useRoofConfigured } from '../measure/RoofLookup';
import { Pointer } from '../measure/roofIcons';

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
  const t = useTakeoff({
    estimateId: null,
    areaId: null,
    address: shown?.key ?? '',
    job: 'attic',
    near: shown?.near ?? null,
  });
  const box = useRef<HTMLInputElement>(null);
  const owner = profile.role === 'owner';
  const docked = Boolean(t.result && t.last && shown);

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
      setShown({
        key,
        label: `the map pin at ${pin.lat}, ${pin.lng}`,
        near: null,
      });
      startIfNew(key, pin);
      return;
    }
    setShown({ key: address, label: address, near: address });
    // A house already looked up on this page shows again; "Look up again" makes a new lookup.
    startIfNew(address, null);
  };

  const editAddress = () => {
    box.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    box.current?.focus();
    box.current?.select();
  };

  return (
    <>
      <main className="mx-auto w-full max-w-2xl space-y-5 px-4 pt-5 pb-8 lg:max-w-5xl lg:px-8 lg:pt-8">
        <PageHeader
          title={
            <span className="inline-flex items-center gap-2.5">
              <Icon icon={Satellite} size="l" />
              Roof lookup
            </span>
          }
          description="Measure any roof from Google's aerial photo. No estimate needed."
        />

        {!online ? (
          <Banner tone="hazard" icon={CloudOff} title="No signal." live={false}>
            The roof lookup needs internet. Your estimates still work offline.
          </Banner>
        ) : !configured ? (
          <Banner tone="warn" live={false}>
            {NOT_CONFIGURED_MESSAGE}
          </Banner>
        ) : null}

        <Card className="lg:max-w-2xl">
          <form onSubmit={lookUp} className="space-y-4" noValidate>
            <Field
              label="Address"
              hint={owner ? 'Each lookup is a paid Google request. A house looked up in the last day comes back free.' : 'The street and town, or the whole address with the ZIP.'}
              error={formError}
            >
              <Input
                ref={box}
                value={text}
                onChange={(e) => setTyped(e.target.value)}
                type="text"
                autoComplete="street-address"
                enterKeyHint="search"
                maxLength={200}
                placeholder="Street, town and ZIP"
                aria-invalid={formError ? true : undefined}
              />
            </Field>
            {/* Hi-vis until there is a result (then the dock's "Start an estimate here" is the one action) or an error (then its next step is). */}
            <Button type="submit" variant={docked || t.state.error ? 'secondary' : 'primary'} size="lg" block icon={Search} disabled={!online || !configured || Boolean(t.state.running)}>
              Look up
            </Button>
          </form>
        </Card>

        {shown ? <TakeoffBody t={t} mode="page" layout="split" label={shown.label} numbers={<PageNumbers t={t} />} steps={{ onEditAddress: editAddress }} /> : null}

        <RecentCard
          online={online}
          owner={owner}
          refreshKey={t.last?.lookupId ?? ''}
          onOpen={(r, lookup) => {
            const key = r.tapped ? `${r.label} ${r.id}` : r.label;
            showLookup(null, key, lookup);
            setShown({ key, label: r.label, near: r.tapped ? null : r.label });
            if (!r.tapped) setTyped(r.label);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />

        {/* Room for the dock, so the last lookups are never under it. */}
        {docked ? <div aria-hidden className="h-[calc(150px+var(--shell-safe))]" /> : null}
      </main>

      {t.result && t.last && shown ? <StartBar t={t} typed={shown.near} profile={profile} /> : null}
    </>
  );
}

/** Looks a typed address (or spot) up unless this page already has (or is getting) it. */
function startIfNew(key: string, pin: LatLng | null) {
  const h = houseLookup(null, key);
  if (!h.running && !h.last) startRoofLookup({ estimateId: null, areaId: null, address: key, pin });
}

/** One reading: a sign label, its meaning, the gauge and its unit (not a choice here: no Use). */
function Reading({ label, meaning, value, unit, small }: { label: string; meaning: string; value: string; unit: string | null; small: boolean }) {
  return (
    <div data-readout className="plate flex min-w-0 flex-col items-start gap-2 p-4">
      <SignLabel tone="ink">{label}</SignLabel>
      <span className="text-[15px] leading-snug font-semibold text-ink-2">{meaning}</span>
      <span className={cx('gauge mt-1 max-w-full text-ink', small ? 'text-[36px]' : 'text-[56px]')}>{value}</span>
      {unit ? <SignLabel tone="ink">{unit}</SignLabel> : null}
    </div>
  );
}

/** The same two numbers as an attic area's sheet: the attic floor and the roof deck. */
function PageNumbers({ t }: { t: Takeoff }) {
  if (!t.f || !t.result || !t.choices) return null;
  const floor = sqftValue(t.f.floorSqft);
  const deck = sqftValue(t.f.deckSqft);
  // Five digits and a comma step down a size, so they stay inside a phone's tile.
  const small = [floor, deck].some((v) => v.length >= 6);
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Reading label="Attic floor" meaning="Blown-in, on the ceiling" value={floor} unit="square feet" small={small} />
        <Reading label="Roof deck" meaning="Spray foam, under the roof" value={deck} unit={t.f.deckSqft === null ? null : 'square feet'} small={small} />
      </div>
      <p className="text-[15px] leading-snug font-medium text-ink-2">Attic floor: {atticFloorNote(t.result, t.choices)}</p>
    </>
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
      ? 'Check the house first: tap Right house.'
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
    <TakeoffDock fixed blocked={error ?? reason} note={parsed ? `A new estimate for ${parsed.street}, ${parsed.city}, with an Attic area that already has these numbers.` : null}>
      <Button variant="primary" size="lg" block icon={busy ? LoaderCircle : HousePlus} disabled={Boolean(reason) || busy || Boolean(t.state.running)} onClick={start}>
        {busy ? 'Starting…' : 'Start an estimate here'}
      </Button>
    </TakeoffDock>
  );
}

/** The recent lookups (the owner sees everyone's). Opening one shows it as it was saved: no new Google call. */
function RecentCard({
  online,
  owner,
  refreshKey,
  onOpen,
}: {
  online: boolean;
  owner: boolean;
  refreshKey: string;
  onOpen: (r: RecentLookup, lookup: Awaited<ReturnType<typeof fetchSavedLookup>>) => void;
}) {
  const [list, setList] = useState<{
    items: RecentLookup[];
    error: string | null;
  } | null>(null);
  const [opening, setOpening] = useState<{
    id: string;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    // navigator.onLine too: the first render after the page opens offline still says online.
    if (!online || !navigator.onLine) return;
    let live = true;
    fetchRecentLookups().then(
      (items) => live && setList({ items, error: null }),
      (e: unknown) =>
        live &&
        setList((prev) => ({
          items: prev?.items ?? [],
          error: e instanceof LookupFailed ? e.message : "Couldn't load the recent lookups.",
        })),
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
      setOpening({
        id: r.id,
        error: e instanceof LookupFailed ? e.message : "Couldn't open that lookup. Try again.",
      });
    }
  };

  const note = 'text-[15px] font-medium text-ink-2';
  return (
    <section aria-labelledby="recent-head" className="space-y-3 lg:max-w-2xl">
      <div className="space-y-1">
        <h2 id="recent-head" className="text-[22px] leading-tight font-extrabold text-ink">
          Recent lookups
        </h2>
        <p className={note}>{owner ? "Everyone's lookups. " : ''}Opening one shows it as it was saved, without a new lookup.</p>
      </div>
      {!online ? (
        <p className={note}>Recent lookups need a connection.</p>
      ) : !list ? (
        <p className={note}>Loading…</p>
      ) : list.error && !list.items.length ? (
        <p className="text-[15px] font-bold text-bad">{list.error}</p>
      ) : !list.items.length ? (
        <p className={note}>No lookups yet. Look up an address above and it shows here.</p>
      ) : (
        <ul className="plate divide-y divide-solid divide-line overflow-hidden">
          {list.items.map((r) => {
            const numbers = [
              r.atticFloorSqft !== null ? `attic floor ${num(roundSqft(r.atticFloorSqft))} sq ft` : null,
              r.roofSqft !== null ? `roof ${num(roundSqft(r.roofSqft))} sq ft` : null,
              r.mainPitch !== null ? pitchText(r.mainPitch) : null,
            ].filter(Boolean);
            return (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r)}
                  disabled={opening?.id === r.id && !opening.error}
                  className="flex min-h-16 w-full items-start gap-3 px-4 py-3 text-left hover:bg-sunken disabled:opacity-60"
                >
                  <span className="mt-0.5 text-ink-2">
                    <Icon icon={r.tapped ? Pointer : House} size="s" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[17px] leading-snug font-bold text-ink [overflow-wrap:anywhere]">{r.label}</span>
                    <span className="block text-[15px] font-medium text-ink-3">
                      {whenText(new Date(r.lookedUpAt))}
                      {r.by ? ` · by ${r.by}` : ''}
                    </span>
                    {numbers.length ? <span className="block text-[15px] font-semibold text-ink-2">{numbers.join(' · ')}</span> : null}
                    {opening?.id === r.id ? <span className={cx('block text-[15px] font-bold', opening.error ? 'text-bad' : 'text-ink-2')}>{opening.error ?? 'Opening…'}</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
