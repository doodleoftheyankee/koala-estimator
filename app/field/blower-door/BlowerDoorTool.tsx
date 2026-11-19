'use client';
// The Blower Door Air Seal Calculator in the field register. Type the gauge's test-in and test-out
// (fan flow and house pressure, as the gauge shows them); the tool converts each to CFM50, shows the
// reduction, the rebate tier of the chosen program (with its cost cap), the ventilation check
// against the BAS, ACH50 and the test-out paperwork, and copies a plain-text summary.
//
// Opened from a job (?job=, the crew app or the office) or an estimate (?estimate=, the field app)
// it also saves the test-in and the test-out to it. A saved reading is shown as recorded (its CFM50
// is never worked out again); "Retake" types a new one, and the newest counts. Everything works
// with no signal: the programs are cached with the other offline data, what was typed is kept on
// the phone between visits, and saved readings wait in an outbox until they sync.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  asReading,
  basMissingText,
  capNote,
  emptyForm,
  evaluate,
  reviveForm,
  savedInputs,
  sourceLine,
  STORIES,
  summaryText,
  ventilationWords,
  type BlowerDoorForm,
  type Stories,
  type TestKind,
} from '@/lib/blowerdoor';
import {
  blowerDoorDb,
  fetchContext,
  formKey,
  getCachedSettings,
  queueTest,
  refreshBlowerDoorSettings,
  saveForm,
  settingsOrEmpty,
  switchBlowerDoorUser,
  syncBlowerDoor,
  type CachedProfile,
  type CachedSettings,
  type LocalContext,
  type LocalForm,
} from '@/lib/offline/blowerDoor';
import { contextKey, mergeReadings, newestOf, newLocalTest, newReading, parseContextParams, type BlowerDoorContext, type LocalTest } from '@/lib/offline/blowerDoorCore';
import { num } from '@/lib/format';
import {
  Banner,
  Button,
  ButtonLink,
  ChevronDown,
  ChevronLeft,
  CloudOff,
  Copy,
  Dock,
  DockSpacer,
  Field,
  Icon,
  Input,
  LoadingSteps,
  Segmented,
  Settings,
  Trash2,
  Wind,
  type ButtonVariant,
} from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { useLive, useOnline } from '../hooks';
import { NumbersList, Paperwork, ResultPlate, TestCard, TierTable, effectiveLine } from './parts';

const SYNC_INTERVAL_MS = 60_000;
/** A gauge-style field; its placeholder ("best source") stays in the text face, so it never reads as a value. */
const GAUGE_INPUT = 'gauge-m text-[26px] placeholder:font-[family-name:var(--f-text)] placeholder:text-[17px] placeholder:[font-stretch:100%]';
const SAVE_DELAY_MS = 300;
const NO_RETAKE: Record<TestKind, boolean> = { test_in: false, test_out: false };

const noSubscribe = () => () => undefined;
/** ?job= or ?estimate= (with &label=), read once on the phone (the cached page serves any query). */
function useContextParam(): BlowerDoorContext | null | undefined {
  const search = useSyncExternalStore(
    noSubscribe,
    () => window.location.search,
    () => null,
  );
  return useMemo(() => (search === null ? undefined : parseContextParams(search)), [search]);
}

export function BlowerDoorTool({ profile }: { profile: CachedProfile }) {
  const context = useContextParam();
  if (context === undefined) return <Loading />;
  return <Tool key={contextKey(context)} profile={profile} context={context} />;
}

function Loading() {
  return (
    <main className="mx-auto w-full max-w-2xl px-4 pt-6">
      <LoadingSteps steps={[{ label: 'Opening the blower door test', state: 'doing' }]} />
    </main>
  );
}

type Loaded = { settings: CachedSettings | null; row: LocalForm | null };

function Tool({ profile, context }: { profile: CachedProfile; context: BlowerDoorContext | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = formKey(profile.userId, context);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await switchBlowerDoorUser(profile).catch(() => undefined);
      const [settings, row] = await Promise.all([getCachedSettings(), blowerDoorDb().forms.get(key).catch(() => undefined)]);
      if (!cancelled) setLoaded({ settings, row: row ?? null });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!loaded) return <Loading />;
  return <ToolBody profile={profile} context={context} initial={loaded} />;
}

function ToolBody({ profile, context, initial }: { profile: CachedProfile; context: BlowerDoorContext | null; initial: Loaded }) {
  const online = useOnline();
  const crew = profile.role === 'crew';
  const key = formKey(profile.userId, context);
  const cKey = contextKey(context);

  const cached = useLive<CachedSettings | null>(() => getCachedSettings(), [], initial.settings);
  const settings = settingsOrEmpty(cached);
  const saved = useLive<LocalContext | undefined>(() => blowerDoorDb().contexts.get(key), [key], undefined);
  const local = useLive<LocalTest[]>(
    () =>
      blowerDoorDb()
        .tests.where('contextKey')
        .equals(cKey)
        .and((t) => t.ownerId === profile.userId)
        .toArray(),
    [cKey, profile.userId],
    [],
  );
  const [contextState, setContextState] = useState<'ok' | 'not-found' | 'signed-out'>('ok');

  // ------------------------------------------------------------------ what was typed, kept on the phone
  const [form, setForm] = useState<BlowerDoorForm>(() => (initial.row ? reviveForm(initial.row.form, settings) : emptyForm(settings)));
  const [retake, setRetake] = useState<Record<TestKind, boolean>>(() => initial.row?.retake ?? NO_RETAKE);
  const [houseFilled, setHouseFilled] = useState<boolean>(() => Boolean(initial.row?.houseFilled));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ form, retake, houseFilled });
  useEffect(() => {
    latest.current = { form, retake, houseFilled };
  }, [form, retake, houseFilled]);

  const persist = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const { form: f, retake: r, houseFilled: h } = latest.current;
    void saveForm({ key, ownerId: profile.userId, contextKey: cKey, form: f, retake: r, houseFilled: h, updatedAt: new Date().toISOString() });
  }, [key, cKey, profile.userId]);
  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(persist, SAVE_DELAY_MS);
  }, [persist]);
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && persist();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      if (timer.current) persist();
    };
  }, [persist]);

  const set = useCallback(
    (patch: Partial<BlowerDoorForm>) => {
      setForm((f) => ({ ...f, ...patch }));
      schedule();
    },
    [schedule],
  );

  // ------------------------------------------------------------------ sync and the job's saved readings
  // Server state arrives in callbacks (never set synchronously in an effect).
  const noteContext = useCallback((r: Awaited<ReturnType<typeof fetchContext>> | 'signed-out' | undefined) => {
    if (r === 'not-found' || r === 'signed-out') setContextState(r);
    else if (r) setContextState('ok');
  }, []);
  const loadContext = useCallback(() => (context ? fetchContext(context, profile.userId).then(noteContext) : Promise.resolve()), [context, profile.userId, noteContext]);

  const runSync = useCallback(
    () =>
      (async () => {
        if (!navigator.onLine) return undefined;
        await refreshBlowerDoorSettings();
        if ((await syncBlowerDoor(profile.userId)) === 'signed-out') return 'signed-out' as const;
        return context ? fetchContext(context, profile.userId) : undefined;
      })().then(noteContext),
    [profile.userId, context, noteContext],
  );

  useEffect(() => {
    const t = setInterval(() => void runSync(), SYNC_INTERVAL_MS);
    const onVisible = () => document.visibilityState === 'visible' && void runSync();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [runSync]);
  // On opening, and whenever the signal comes back.
  useEffect(() => {
    if (online) void runSync();
  }, [online, runSync]);

  const shown = useMemo(() => mergeReadings(saved?.tests ?? [], local), [saved, local]);
  const savedIn = context && !retake.test_in ? newestOf(shown, 'test_in') : null;
  const savedOut = context && !retake.test_out ? newestOf(shown, 'test_out') : null;

  // The house (BAS inputs) given with a saved reading fills the empty fields once per job.
  useEffect(() => {
    if (houseFilled || !context) return;
    const withHouse = shown.find((r) => r.test.bas_audit !== null || r.test.volume !== null || r.test.occupants !== null);
    if (!withHouse) return;
    const f = latest.current.form;
    if (f.bas || f.volume || f.occupants) return;
    const fill = savedInputs(withHouse.test);
    if (crew) delete fill.cost;
    setForm((cur) => ({ ...cur, ...fill }));
    setHouseFilled(true);
    schedule();
  }, [shown, houseFilled, context, crew, schedule]);

  const e = useMemo(
    () => evaluate({ form, settings, savedIn: savedIn ? asReading(savedIn.test) : null, savedOut: savedOut ? asReading(savedOut.test) : null }),
    [form, settings, savedIn, savedOut],
  );
  const label = saved?.label ?? context?.label ?? null;
  const summary = summaryText(e, settings, label);

  // ------------------------------------------------------------------ saving a reading
  const save = async (kind: TestKind) => {
    if (!context) return;
    const test = newReading({ id: crypto.randomUUID(), kind, context, evaluation: e, program: e.program, form, recordedAt: new Date().toISOString(), includePrice: !crew });
    if (!test) return;
    await queueTest(newLocalTest(test, context, profile.userId, profile.fullName, crypto.randomUUID()));
    setRetake((r) => ({ ...r, [kind]: false }));
    schedule();
    void syncBlowerDoor(profile.userId).then(() => loadContext());
  };
  const startRetake = (kind: TestKind) => {
    const r = kind === 'test_in' ? savedIn : savedOut;
    if (r) set(kind === 'test_in' ? { preCfm: String(r.test.cfm), prePa: String(r.test.pa) } : { postCfm: String(r.test.cfm), postPa: String(r.test.pa) });
    setRetake((x) => ({ ...x, [kind]: true }));
    schedule();
  };
  const cancelRetake = (kind: TestKind) => {
    setRetake((x) => ({ ...x, [kind]: false }));
    schedule();
  };

  // The one hi-vis action: the next reading to save, else Copy summary.
  const next: 'test_in' | 'test_out' | 'copy' =
    context && !savedIn && e.testIn.reading ? 'test_in' : context && !savedOut && e.testOut.reading ? 'test_out' : 'copy';
  const saveVariant = (k: TestKind): ButtonVariant => (next === k ? 'primary' : 'secondary');

  // ------------------------------------------------------------------ copy and clear
  const [copyState, setCopyState] = useState<string | null>(null);
  const copy = async () => {
    const say = (t: string) => {
      setCopyState(t);
      setTimeout(() => setCopyState(null), 1800);
    };
    if (!summary) return say('Enter both tests first');
    try {
      await navigator.clipboard.writeText(summary);
      say('Copied');
    } catch {
      say('Copy blocked: select the summary below instead');
    }
  };
  const clear = () => {
    const fresh = emptyForm(settings, form.programKey);
    // Opened from a job or an estimate, the house (BAS inputs) belongs to it and stays.
    setForm(context ? { ...fresh, bas: form.bas, volume: form.volume, occupants: form.occupants, stories: form.stories, nFactor: form.nFactor } : fresh);
    setRetake(NO_RETAKE);
    schedule();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // ------------------------------------------------------------------ words
  const program = e.program;
  const back = context ? backLink(context, profile.role) : null;
  const where = context?.kind === 'estimate' ? 'estimate' : 'job';
  const capLabel = program?.costCapPct != null ? `Rebate after ${num(program.costCapPct, 2)}% cost cap` : null;
  const vent = e.ventilation && e.bas.value !== null ? ventilationWords(e.ventilation, e.bas.value, e.bas, program) : null;
  const basNote = e.testOut.reading ? basMissingText(e.bas) : null;
  const nHint =
    settings.nFactor === 19
      ? "N-factor 19 is BPI's Zone 2 example value (Zone 2 runs 17–20); match it to your audit software."
      : `N-factor ${num(settings.nFactor, 2)} is your office's default; match it to your audit software.`;

  return (
    <>
      <main className="mx-auto w-full max-w-2xl space-y-4 px-4 pt-5 pb-8">
        {back ? (
          <a href={back.href} className="-ml-2 inline-flex min-h-12 items-center gap-1 rounded-control px-2 text-[16px] font-bold text-ink-2 hover:bg-sunken hover:text-ink">
            <Icon icon={ChevronLeft} size="s" />
            {back.label}
          </a>
        ) : null}
        <PageHeader
          title={
            <span className="inline-flex items-center gap-2.5">
              <Icon icon={Wind} size="l" />
              Blower door
            </span>
          }
          description={
            context
              ? `Readings you save go to this ${where}${label ? `: ${label}` : ''}.`
              : `${settings.gauge} · flows normalized to 50 Pa. Open it from a job or an estimate to save the readings.`
          }
        />

        {!online ? (
          <Banner tone="hazard" icon={CloudOff} title="Offline." live={false}>
            {context ? 'The calculator works, and saved readings wait on this phone until you are back online.' : 'The calculator works with no signal.'}
          </Banner>
        ) : null}
        {contextState === 'not-found' ? (
          <Banner tone="bad" title={`This ${where} is not one you can save readings to.`}>
            It may have been reassigned. Readings saved here stay on this phone; ask the office.
          </Banner>
        ) : null}
        {contextState === 'signed-out' ? (
          <Banner tone="bad" title="Your session expired." action={<ButtonLink href={`/login?next=${encodeURIComponent('/field/blower-door')}`} size="sm" prefetch={false}>Sign in again</ButtonLink>}>
            Your readings are saved on this phone. Sign in again to sync them.
          </Banner>
        ) : null}

        <ResultPlate e={e} />

        {vent ? (
          <Banner tone={vent.tone} live={false}>
            <span data-testid="bd-ventilation">{vent.text}</span>
          </Banner>
        ) : null}

        {/* ------------------------------------------------------------ program */}
        {program ? (
          <section aria-labelledby="bd-program" className="plate p-4">
            <h2 id="bd-program" className="sign-label text-ink [--sign-size:14px]">
              Program
            </h2>
            <Segmented
              label="Rebate program"
              className="mt-2"
              value={program.key}
              options={settings.programs.map((p) => ({ value: p.key, label: p.label }))}
              onChange={(k) => set({ programKey: k })}
            />
            <p className="mt-2 text-[15px] leading-snug font-medium text-ink-2">
              {program.name}. {effectiveLine(program.effectiveDate)}
            </p>
          </section>
        ) : cached === null ? (
          <Banner tone="warn" title="The rebate programs are not on this phone yet." live={false}>
            Connect once to load them. Until then the tool converts the readings and checks ventilation.
          </Banner>
        ) : (
          <Banner
            tone="warn"
            title="No rebate program set up."
            live={false}
            action={
              profile.role === 'owner' ? (
                <ButtonLink href="/admin/rebates" size="sm" icon={Settings} prefetch={false}>
                  Set up programs
                </ButtonLink>
              ) : null
            }
          >
            The tool converts the readings and checks ventilation.{' '}
            {profile.role === 'owner' ? 'Add your programs on Rebate programs to see tiers and rebates.' : 'Ask the owner to add the programs on the Rebate programs page.'}
          </Banner>
        )}

        {/* ------------------------------------------------------------ the two tests */}
        <TestCard
          kind="test_in"
          saved={savedIn}
          result={e.testIn}
          cfm={form.preCfm}
          pa={form.prePa}
          onCfm={(v) => set({ preCfm: v })}
          onPa={(v) => set({ prePa: v })}
          canSave={Boolean(context)}
          saveVariant={saveVariant('test_in')}
          onSave={() => void save('test_in')}
          onRetake={() => startRetake('test_in')}
          onCancelRetake={context && retake.test_in && newestOf(shown, 'test_in') ? () => cancelRetake('test_in') : null}
          online={online}
        />
        <TestCard
          kind="test_out"
          saved={savedOut}
          result={e.testOut}
          cfm={form.postCfm}
          pa={form.postPa}
          onCfm={(v) => set({ postCfm: v })}
          onPa={(v) => set({ postPa: v })}
          hint="Type the pressure exactly as the gauge shows it. The minus sign doesn't matter. Tip: with Set Pressure at 50, tap the gauge's [@] key before the photo so the screen shows flow at exactly 50 Pa."
          canSave={Boolean(context)}
          saveVariant={saveVariant('test_out')}
          onSave={() => void save('test_out')}
          onRetake={() => startRetake('test_out')}
          onCancelRetake={context && retake.test_out && newestOf(shown, 'test_out') ? () => cancelRetake('test_out') : null}
          online={online}
        />

        <TierTable e={e} />

        {/* ------------------------------------------------------------ cost cap (not for crews: they never see prices) */}
        {program?.costCapPct != null && !crew ? (
          <section aria-labelledby="bd-cost" className="plate p-4">
            <h2 id="bd-cost" className="sign-label text-ink [--sign-size:14px]">
              Cost cap (optional)
            </h2>
            <Field
              className="mt-2"
              label="Air sealing price ($)"
              error={e.costError}
              hint={`Air sealing rebate pays the tier amount or ${num(program.costCapPct, 2)}% of the installed air sealing cost, whichever is lower.${capNote(e)}`}
            >
              <Input value={form.cost} onChange={(ev) => set({ cost: ev.target.value })} inputMode="decimal" autoComplete="off" placeholder={`for ${num(program.costCapPct, 2)}% cap`} className={GAUGE_INPUT} />
            </Field>
          </section>
        ) : program?.costCapPct != null && crew ? (
          <p className="px-1 text-[15px] leading-snug font-medium text-ink-2">
            The rebate shown is the tier amount. The office applies the {num(program.costCapPct, 2)}% cost cap.
          </p>
        ) : null}

        {/* ------------------------------------------------------------ ventilation */}
        <section aria-labelledby="bd-vent" className="plate space-y-3 p-4">
          <h2 id="bd-vent" className="sign-label text-ink [--sign-size:14px]">
            Ventilation check (BAS)
          </h2>
          <Field label="BAS from audit (CFM50)" error={e.basErrors.bas} hint="Use the Building Airflow Standard from the energy assessment report if you have it. If not, estimate it below.">
            <Input value={form.bas} onChange={(ev) => set({ bas: ev.target.value })} inputMode="decimal" autoComplete="off" placeholder="best source" className={GAUGE_INPUT} />
          </Field>
          <h3 className="pt-1 text-[16px] font-bold text-ink">Or estimate it (BPI / ASHRAE 62-89 method)</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field label="House volume (ft³)" error={e.basErrors.volume}>
              <Input value={form.volume} onChange={(ev) => set({ volume: ev.target.value })} inputMode="decimal" autoComplete="off" placeholder="incl. basement" className={GAUGE_INPUT} />
            </Field>
            <Field label="Occupants" error={e.basErrors.occupants}>
              <Input value={form.occupants} onChange={(ev) => set({ occupants: ev.target.value })} inputMode="numeric" autoComplete="off" placeholder="actual people" className={GAUGE_INPUT} />
            </Field>
          </div>
          <Field label="Stories" group>
            <Segmented<Stories> label="Stories" value={form.stories} options={STORIES.map((s) => ({ value: s.value, label: s.label }))} onChange={(v) => set({ stories: v })} />
          </Field>
          <Field label="Zone N-factor" error={e.basErrors.nFactor} hint={nHint}>
            <Input value={form.nFactor} onChange={(ev) => set({ nFactor: ev.target.value })} inputMode="decimal" autoComplete="off" className={GAUGE_INPUT} />
          </Field>
          <p className="text-[15px] leading-snug font-medium text-ink-2">
            BAS = the larger of (0.35 × volume ÷ 60) or (15 × occupants), times the N-factor, times the height correction.
          </p>
          {basNote ? <p className="text-[15.5px] leading-snug font-bold text-warn">{basNote}</p> : null}
          <details className="group rounded-control border-solid border-[length:var(--bw)] border-line px-3" open={Boolean(e.exponentError) || undefined}>
            <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 text-[16px] font-bold text-ink [&::-webkit-details-marker]:hidden">
              Advanced
              <Icon icon={ChevronDown} size="s" className="transition-transform group-open:rotate-180" />
            </summary>
            <div className="pb-3">
              <Field
                label="Flow exponent (n)"
                error={e.exponentError}
                hint={`CFM50 = CFM × (50 ÷ Pa)^n. The default, ${num(settings.flowExponent, 3)}, is set by the office to match the ${settings.gauge}, so this matches the gauge's own @ Pressure result. Saved readings keep the exponent they were taken with.`}
              >
                <Input value={form.exponent} onChange={(ev) => set({ exponent: ev.target.value })} inputMode="decimal" autoComplete="off" className={GAUGE_INPUT} />
              </Field>
            </div>
          </details>
        </section>

        <NumbersList e={e} capLabel={crew ? null : capLabel} />

        {program ? <Paperwork items={program.paperwork} source={sourceLine(program, settings)} /> : <Paperwork items={[]} source={sourceLine(null, settings)} />}

        {summary && copyState?.startsWith('Copy blocked') ? (
          <Field label="Summary">
            <textarea readOnly value={summary} rows={8} className="block w-full rounded-control border-solid border-[length:var(--bw)] border-line-strong bg-surface p-3 font-mono text-[15px] text-ink" onFocus={(ev) => ev.currentTarget.select()} />
          </Field>
        ) : null}

        <DockSpacer />
      </main>

      <Dock label="Blower door actions" note={summary ? undefined : 'Copy summary works once both tests are in.'}>
        <Button variant={next === 'copy' ? 'primary' : 'secondary'} size="lg" icon={Copy} onClick={() => void copy()} aria-live="polite" className="min-w-0 flex-1">
          {copyState ?? 'Copy summary'}
        </Button>
        <Button size="lg" variant="ghost" icon={Trash2} onClick={clear} className="shrink-0">
          {context ? 'Clear typed' : 'Clear for new job'}
        </Button>
      </Dock>
    </>
  );
}

/** Back to where the tool was opened from: a plain link (the crew and field apps open offline). */
function backLink(c: BlowerDoorContext, role: CachedProfile['role']): { href: string; label: string } {
  if (c.kind === 'estimate') return { href: `/field?e=${encodeURIComponent(c.id)}`, label: 'Estimate' };
  return role === 'crew' ? { href: `/crew?j=${encodeURIComponent(c.id)}`, label: 'Job' } : { href: `/jobs/${encodeURIComponent(c.id)}`, label: 'Job' };
}
