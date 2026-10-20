import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { parseLearningSettings } from '@/lib/learning';
import { STALE_RUN_MS } from '@/lib/learning/nightlyCore';
import { errorMessage } from '@/lib/admin/forms';
import {
  accuracySentences,
  backtestRows,
  CANDIDATE_SET_COLUMNS,
  candidateNotes,
  candidateSetRowSchema,
  canRestore,
  CHANGE_COLUMNS,
  COEFFICIENT_COLUMNS,
  coefficientChangeRowSchema,
  coefficientRowSchema,
  coefficientSetRowSchema,
  confidencePct,
  diffCoefficients,
  formatCoef,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMape,
  formatMetric,
  formatNEff,
  formatPct,
  formatSignedPct,
  formatStdError,
  groupByKind,
  hasAccuracy,
  isStalledRun,
  jobTypeLabel,
  KIND_LABELS,
  learningRunRowSchema,
  noticeMessage,
  outcomeLabel,
  parseAccuracy,
  parseGates,
  parseHoldout,
  parseNotice,
  parseRow,
  parseRows,
  parseRunMeta,
  parseWinMetrics,
  parseWinRunSummary,
  pctChange,
  plural,
  profileNameRowSchema,
  RUN_COLUMNS,
  runKindLabel,
  scopeLabel,
  scopeNamesFrom,
  SET_COLUMNS,
  SET_STATUS_LABELS,
  SET_STATUS_TONES,
  setSourceLabel,
  sparkline,
  WIN_MODEL_COLUMNS,
  winColdStartMessage,
  winModelRowSchema,
  type CoefficientDiff,
  type DashboardCoefficient,
  type LearningRunRow,
  type ScopeNames,
  type WinBuckets,
} from '@/lib/admin/learning';
import { SectionHeading } from '../pricing/fields';
import { approveCandidate, rejectCandidate, restoreSet, runLearningNow } from './actions';
import { ApproveForm, RejectForm, RestoreSetButton, RunNowForm } from './LearningForms';

export const metadata: Metadata = { title: 'Learning' };
// "Run learning now" is a Server Action on this page; give it the same budget as the nightly cron.
export const maxDuration = 300;

const HISTORY_LIMIT = 100;
const CHANGELOG_LIMIT = 200;
const RUN_LOG_LIMIT = 50;
const ACCURACY_RUNS = 10;
const IN_CHUNK = 100;

// ---------------------------------------------------------------------------
// Data (the signed-in user's client: RLS lets owner and office read every learning table)
// ---------------------------------------------------------------------------

type Db = Awaited<ReturnType<typeof createClient>>;
type Res = { data: unknown; error: { message: string } | null };

const nameRows = z.array(z.object({ code: z.string(), label: z.string() }));
const settingRow = z.object({ value: z.unknown() }).nullable();
const setVersionRows = z.array(z.object({ id: z.string(), version: z.coerce.number() }));

function ok(r: Res, what: string): unknown {
  if (r.error) throw new Error(`Loading ${what} failed: ${r.error.message}`);
  return r.data;
}

const chunk = <T,>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

async function loadCoefficients(db: Db, setId: string | undefined): Promise<DashboardCoefficient[]> {
  if (!setId) return [];
  const r = await db.from('coefficients').select(COEFFICIENT_COLUMNS).eq('set_id', setId);
  return parseRows(coefficientRowSchema, ok(r, 'coefficients'), 'coefficient');
}

async function loadDashboard(db: Db) {
  const [active, candidate, sets, runs, lastCalibration, calibrations, winRun, winModel, changes, settings, products, jobTypes, accessLevels] =
    await Promise.all([
      db.from('coefficient_sets').select(SET_COLUMNS).eq('status', 'active').maybeSingle(),
      db.from('coefficient_sets').select(CANDIDATE_SET_COLUMNS).eq('status', 'candidate').order('version', { ascending: false }).limit(1).maybeSingle(),
      db.from('coefficient_sets').select(SET_COLUMNS).order('version', { ascending: false }).limit(HISTORY_LIMIT),
      db.from('learning_runs').select(RUN_COLUMNS).order('started_at', { ascending: false }).limit(RUN_LOG_LIMIT),
      db.from('learning_runs').select(RUN_COLUMNS).eq('kind', 'calibration').order('started_at', { ascending: false }).limit(1).maybeSingle(),
      // A few extra in case some succeeded without accuracy (no verified jobs yet).
      db
        .from('learning_runs')
        .select(RUN_COLUMNS)
        .eq('kind', 'calibration')
        .eq('status', 'succeeded')
        .order('started_at', { ascending: false })
        .limit(ACCURACY_RUNS * 3),
      db.from('learning_runs').select(RUN_COLUMNS).eq('kind', 'win_model').eq('status', 'succeeded').order('started_at', { ascending: false }).limit(1).maybeSingle(),
      db.from('win_models').select(WIN_MODEL_COLUMNS).eq('is_active', true).maybeSingle(),
      db.from('coefficient_changes').select(CHANGE_COLUMNS).order('at', { ascending: false }).order('id', { ascending: false }).limit(CHANGELOG_LIMIT),
      db.from('app_settings').select('value').eq('key', 'learning').maybeSingle(),
      db.from('products').select('code, label'),
      db.from('job_types').select('code, label'),
      db.from('access_levels').select('code, label'),
    ]);

  const activeSet = parseRow(coefficientSetRowSchema, ok(active, 'the active coefficient set'), 'coefficient set');
  const candidateSet = parseRow(candidateSetRowSchema, ok(candidate, 'the pending candidate'), 'coefficient set');
  const setRows = parseRows(coefficientSetRowSchema, ok(sets, 'coefficient sets'), 'coefficient set');
  const runRows = parseRows(learningRunRowSchema, ok(runs, 'learning runs'), 'learning run');
  const changeRows = parseRows(coefficientChangeRowSchema, ok(changes, 'the changelog'), 'coefficient change');
  const names: ScopeNames = scopeNamesFrom({
    products: nameRows.parse(ok(products, 'products') ?? []),
    jobTypes: nameRows.parse(ok(jobTypes, 'job types') ?? []),
    accessLevels: nameRows.parse(ok(accessLevels, 'access levels') ?? []),
  });

  // Versions for sets that are referenced (changelog, run log, restored copies) but older than the history page.
  const versionBySet = new Map(setRows.map((s) => [s.id, s.version]));
  if (activeSet) versionBySet.set(activeSet.id, activeSet.version);
  if (candidateSet) versionBySet.set(candidateSet.id, candidateSet.version);
  const referenced = [
    ...changeRows.flatMap((c) => [c.fromSetId, c.toSetId]),
    ...runRows.map((r) => r.candidate_set_id),
    ...setRows.map((s) => s.parent_id),
  ];
  const missing = [...new Set(referenced)].filter((x): x is string => !!x && !versionBySet.has(x));

  // Everyone named on the page: who approved, restored, created or triggered what.
  const runMeta = new Map(runRows.map((r) => [r.id, parseRunMeta(r.summary)]));
  const actorIds = new Set<string>();
  for (const c of changeRows) if (c.actorId) actorIds.add(c.actorId);
  for (const s of setRows) for (const a of [s.created_by, s.activated_by]) if (a) actorIds.add(a);
  for (const m of runMeta.values()) if (m.actorId) actorIds.add(m.actorId);

  const [activeCoefficients, candidateCoefficients, versions, people] = await Promise.all([
    loadCoefficients(db, activeSet?.id),
    loadCoefficients(db, candidateSet?.id),
    Promise.all(chunk(missing, IN_CHUNK).map((ids) => db.from('coefficient_sets').select('id, version').in('id', ids))),
    Promise.all(chunk([...actorIds], IN_CHUNK).map((ids) => db.from('profiles').select('id, full_name').in('id', ids))),
  ]);
  for (const r of versions) for (const s of setVersionRows.parse(ok(r, 'set versions') ?? [])) versionBySet.set(s.id, s.version);
  const peopleById = new Map<string, string>();
  for (const r of people) for (const p of parseRows(profileNameRowSchema, ok(r, 'team names'), 'profile')) peopleById.set(p.id, p.full_name);

  const calibrationRuns = parseRows(learningRunRowSchema, ok(calibrations, 'calibration runs'), 'learning run');
  const accuracy = calibrationRuns
    .map((r) => ({ run: r, report: parseAccuracy(r.summary) }))
    .filter((x): x is { run: LearningRunRow; report: NonNullable<typeof x.report> } => hasAccuracy(x.report))
    .slice(0, ACCURACY_RUNS);

  const lastCalibrationRow = parseRow(learningRunRowSchema, ok(lastCalibration, 'the last calibration run'), 'learning run');
  const winRunRow = parseRow(learningRunRowSchema, ok(winRun, 'the latest win-model run'), 'learning run');
  const winModelRow = parseRow(winModelRowSchema, ok(winModel, 'the active win model'), 'win model');
  const settingsRow = settingRow.parse(ok(settings, 'learning settings') ?? null);

  return {
    activeSet,
    activeCoefficients,
    candidate: candidateSet
      ? {
          set: candidateSet,
          diff: diffCoefficients(candidateCoefficients, activeCoefficients, candidateNotes(candidateSet.metrics)),
          gates: parseGates(candidateSet.gate_results),
          holdout: parseHoldout(candidateSet.metrics),
          runMessage: candidateSet.learning_run_id ? (runMeta.get(candidateSet.learning_run_id)?.message ?? null) : null,
        }
      : null,
    sets: setRows,
    runs: runRows.map((r) => ({ row: r, meta: runMeta.get(r.id) ?? parseRunMeta(null) })),
    lastCalibration: lastCalibrationRow,
    lastCalibrationStalled: lastCalibrationRow ? isStalledRun(lastCalibrationRow, Date.now(), STALE_RUN_MS) : false,
    accuracy,
    winRun: winRunRow ? { row: winRunRow, summary: parseWinRunSummary(winRunRow.summary) } : null,
    winModel: winModelRow ? { row: winModelRow, metrics: parseWinMetrics(winModelRow.metrics) } : null,
    changes: changeRows,
    settings: parseLearningSettings(settingsRow?.value),
    names,
    people: peopleById,
    versionBySet,
  };
}

type Dashboard = Awaited<ReturnType<typeof loadDashboard>>;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'candidate', label: 'Pending' },
  { id: 'coefficients', label: 'Coefficients' },
  { id: 'accuracy', label: 'Accuracy' },
  { id: 'win-rate', label: 'Win rate' },
  { id: 'history', label: 'History' },
  { id: 'changelog', label: 'Changelog' },
  { id: 'runs', label: 'Run log' },
] as const;

export default async function LearningPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireRole('owner', 'office');
  const isOwner = profile.role === 'owner';
  const notice = parseNotice(await searchParams);
  const db = await createClient();

  let data: Dashboard | null = null;
  let loadError: string | null = null;
  try {
    data = await loadDashboard(db);
  } catch (e) {
    loadError = errorMessage(e);
  }

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Learning</h1>
          {isOwner ? null : <Badge tone="blue">Read-only</Badge>}
        </div>
        <p className="text-sm text-slate-600">
          Every completed job with verified actuals teaches the pricing model. Each night the system proposes new coefficients, checks them against
          guardrails and recent jobs, and {isOwner ? 'waits for your approval' : "waits for the owner's approval"} unless auto-promote is on.
        </p>
        {notice ? <Alert tone="green">{noticeMessage(notice)}</Alert> : null}
        {isOwner ? null : <Alert tone="blue">You can view everything here. Only the owner can run learning, approve, reject or restore sets.</Alert>}
        {loadError || !data ? (
          <Alert tone="red">Could not load the learning dashboard: {loadError}</Alert>
        ) : (
          <LearningContent data={data} isOwner={isOwner} />
        )}
      </main>
    </>
  );
}

function LearningContent({ data, isOwner }: { data: Dashboard; isOwner: boolean }) {
  return (
    <>
      <nav aria-label="Learning sections" className="sticky top-0 z-10 -mx-4 overflow-x-auto border-b border-slate-200 bg-slate-50/95 px-4 py-2 backdrop-blur">
        <ul className="flex gap-2 whitespace-nowrap">
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <a
                href={`#${s.id}`}
                className="inline-flex min-h-10 items-center rounded-full bg-white px-4 text-sm font-medium text-slate-700 ring-1 ring-slate-300 hover:bg-brand-50 hover:text-brand-800"
              >
                {s.label}
                {s.id === 'candidate' && data.candidate ? (
                  <>
                    <span aria-hidden="true" className="ml-2 h-2 w-2 rounded-full bg-amber-500" />
                    <span className="sr-only"> (1 waiting)</span>
                  </>
                ) : null}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <Overview data={data} isOwner={isOwner} />
      <Candidate data={data} isOwner={isOwner} />
      <ActiveCoefficients data={data} />
      <Accuracy data={data} />
      <WinRate data={data} />
      <History data={data} isOwner={isOwner} />
      <Changelog data={data} />
      <RunLog data={data} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="mt-1 text-lg font-semibold text-slate-900">{children}</div>
      {sub ? <div className="mt-1 text-sm text-slate-600">{sub}</div> : null}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-600">{children}</p>;
}

/** A horizontally scrollable table on phones. */
function Table({ minWidth = 'min-w-[640px]', head, children }: { minWidth?: string; head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${minWidth} text-left text-sm`}>
        <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
          <tr>{head}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

function Th({ children, right = false }: { children?: ReactNode; right?: boolean }) {
  return (
    <th scope="col" className={`px-3 py-2 ${right ? 'text-right' : ''}`}>
      {children}
    </th>
  );
}

function Td({ children, right = false, className = '' }: { children?: ReactNode; right?: boolean; className?: string }) {
  return <td className={`px-3 py-2 align-top ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>;
}

function RunStatusBadge({ status }: { status: LearningRunRow['status'] }) {
  if (status === 'succeeded') return <Badge tone="green">Succeeded</Badge>;
  if (status === 'failed') return <Badge tone="red">Failed</Badge>;
  return <Badge tone="blue">Running</Badge>;
}

function ConfidenceBar({ value }: { value: number }) {
  const c = confidencePct(value);
  return (
    <span className="inline-flex items-center justify-end gap-2">
      <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-full bg-slate-200">
        <span className={`block h-full rounded-full ${c >= 70 ? 'bg-emerald-500' : c >= 40 ? 'bg-brand-600' : 'bg-amber-500'}`} style={{ width: `${c}%` }} />
      </span>
      <span className="w-8 tabular-nums">{c}</span>
    </span>
  );
}

function Change({ pct }: { pct: number | null }) {
  if (pct === null || Math.abs(pct) < 0.0005) return <span className="text-slate-400">{pct === null ? '—' : '0%'}</span>;
  return <span className={pct > 0 ? 'text-amber-700' : 'text-sky-700'}>{formatSignedPct(pct)}</span>;
}

const personName = (data: Dashboard, id: string | null) => (id ? (data.people.get(id) ?? 'Former team member') : null);
const versionLabel = (data: Dashboard, id: string | null) => {
  if (!id) return '—';
  const v = data.versionBySet.get(id);
  return v === undefined ? '—' : `v${v}`;
};

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function Overview({ data, isOwner }: { data: Dashboard; isOwner: boolean }) {
  const { activeSet, lastCalibration: last } = data;
  const lastMeta = last ? parseRunMeta(last.summary) : null;
  return (
    <section className="space-y-3">
      <SectionHeading id="overview" title="Overview" />
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat
            label="Active set"
            sub={
              activeSet ? (
                <>
                  {setSourceLabel(activeSet.source)} · active since {formatDateTime(activeSet.activated_at)}
                </>
              ) : (
                'Pricing will not work until a set is active. Restore one from History.'
              )
            }
          >
            {activeSet ? `v${activeSet.version}` : <span className="text-red-700">None</span>}
          </Stat>
          <Stat
            label="Last calibration"
            sub={
              last ? (
                <>
                  {last.status === 'running' ? `Started ${formatDateTime(last.started_at)}` : `Finished ${formatDateTime(last.finished_at)}`}
                  {data.lastCalibrationStalled ? (
                    <span className="block text-amber-800">It never finished (timed out or crashed); the next run closes it and starts over.</span>
                  ) : null}
                  {lastMeta?.trigger === 'manual' ? ' · run by hand' : ''}
                  {last.status === 'failed' && last.error ? <span className="block text-red-700">{last.error}</span> : null}
                  {last.status === 'succeeded' && lastMeta?.outcome ? <span className="block">{outcomeLabel(lastMeta.outcome)}</span> : null}
                </>
              ) : (
                'No run yet.'
              )
            }
          >
            {last ? <RunStatusBadge status={last.status} /> : <span className="text-slate-500">—</span>}
          </Stat>
          <Stat label="Schedule" sub="Runs nightly at about 2:15 AM Eastern (3:15 AM while daylight saving time is on). All times on this page are Eastern.">
            Nightly
          </Stat>
        </div>
        {isOwner ? (
          <div className="border-t border-slate-200 pt-4">
            <p className="mb-3 text-sm text-slate-600">
              Runs tonight&apos;s job now: recalibrates from verified actuals, retrains the win model and expires stale quotes. The same guardrails
              apply, so nothing reaches pricing unless every gate passes and auto-promote is on
              {data.settings.autoPromote ? ' (it is on)' : ' (it is off: you approve each set below)'}.
            </p>
            <RunNowForm action={runLearningNow} />
          </div>
        ) : null}
      </Card>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pending candidate
// ---------------------------------------------------------------------------

function Candidate({ data, isOwner }: { data: Dashboard; isOwner: boolean }) {
  const c = data.candidate;
  return (
    <section className="space-y-3">
      <SectionHeading id="candidate" title="Pending candidate">
        A new set of coefficients waiting for approval. Pricing keeps using the active set until it is approved.
      </SectionHeading>
      {!c ? (
        <Empty>No candidate is waiting. The nightly run creates one when verified job actuals move a coefficient.</Empty>
      ) : (
        <Card className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-lg font-semibold text-slate-900">Candidate v{c.set.version}</h3>
            <Badge tone="amber">Waiting for approval</Badge>
            <span className="text-sm text-slate-500">
              {setSourceLabel(c.set.source)} · created {formatDateTime(c.set.created_at)}
            </span>
            {c.set.notes ? <p className="w-full text-sm text-slate-600">{c.set.notes}</p> : null}
            {c.runMessage ? <p className="w-full text-sm text-slate-600">{c.runMessage}</p> : null}
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="min-w-0">
              <h4 className="mb-2 font-semibold text-slate-900">Guardrails</h4>
              {c.gates.length ? (
                <ul className="space-y-2">
                  {c.gates.map((g) => (
                    <li key={g.name} className="flex gap-2 text-sm">
                      <span className="shrink-0">{g.passed ? <Badge tone="green">Pass</Badge> : <Badge tone="red">Fail</Badge>}</span>
                      <span>
                        <span className="font-medium text-slate-900">{g.label}.</span> <span className="text-slate-600">{g.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-600">No gate results were recorded for this set.</p>
              )}
              {c.gates.some((g) => !g.passed) ? (
                <div className="mt-3">
                  <Alert tone="amber">This candidate failed a guardrail. Approving it overrides that check.</Alert>
                </div>
              ) : null}
            </div>
            <div className="min-w-0">
              <h4 className="mb-2 font-semibold text-slate-900">Backtest</h4>
              {c.holdout ? (
                <>
                  <p className="mb-2 text-sm text-slate-600">
                    Average error on the most recent {formatCount(c.holdout.n)} job {plural(c.holdout.n, 'area')}, which the candidate did not learn
                    from. Lower is better.
                  </p>
                  <Table minWidth="min-w-[320px]" head={<><Th /><Th right>Active</Th><Th right>Candidate</Th><Th right /></>}>
                    {backtestRows(c.holdout).map((r) => (
                      <tr key={r.metric}>
                        <Td className="font-medium text-slate-800">{r.label}</Td>
                        <Td right>{formatMape(r.active)}</Td>
                        <Td right>{formatMape(r.candidate)}</Td>
                        <Td right>
                          {r.verdict === 'better' ? <Badge tone="green">Better</Badge> : null}
                          {r.verdict === 'worse' ? <Badge tone="red">Worse</Badge> : null}
                          {r.verdict === 'same' ? <Badge>Same</Badge> : null}
                        </Td>
                      </tr>
                    ))}
                  </Table>
                </>
              ) : (
                <p className="text-sm text-slate-600">No backtest was recorded (too few completed jobs, or a manual set).</p>
              )}
            </div>
          </div>

          <div className="min-w-0">
            <h4 className="mb-2 font-semibold text-slate-900">
              What changes{data.activeSet ? ` compared with v${data.activeSet.version}` : ''} ({c.diff.length})
            </h4>
            {c.diff.length ? <DiffTable diff={c.diff} names={data.names} /> : <p className="text-sm text-slate-600">No coefficient differs from the active set.</p>}
          </div>

          {isOwner ? (
            <div className="grid gap-4 border-t border-slate-200 pt-4 md:grid-cols-2">
              <ApproveForm action={approveCandidate} setId={c.set.id} version={c.set.version} changed={c.diff.length} />
              <RejectForm action={rejectCandidate} setId={c.set.id} version={c.set.version} />
            </div>
          ) : null}
        </Card>
      )}
    </section>
  );
}

function DiffTable({ diff, names }: { diff: CoefficientDiff[]; names: ScopeNames }) {
  return (
    <Table
      minWidth="min-w-[920px]"
      head={
        <>
          <Th>Coefficient</Th>
          <Th>Applies to</Th>
          <Th right>Old → new</Th>
          <Th right>Change</Th>
          <Th right>n</Th>
          <Th right>n_eff</Th>
          <Th right>Confidence</Th>
          <Th>Notes</Th>
        </>
      }
    >
      {diff.map((d) => (
        <tr key={d.key}>
          <Td className="font-medium text-slate-800">{KIND_LABELS[d.kind]}</Td>
          <Td>{scopeLabel(d, names)}</Td>
          <Td right>
            <span className="whitespace-nowrap">
              {d.change === 'new' ? <span className="text-slate-400">{formatCoef(d.baseValue)} (inherited)</span> : formatCoef(d.oldValue)} →{' '}
              <span className="font-semibold text-slate-900">{d.change === 'removed' ? 'removed' : formatCoef(d.newValue)}</span>
            </span>
          </Td>
          <Td right>
            <Change pct={d.pctChange} />
          </Td>
          <Td right>{d.sampleSize === null ? '—' : formatCount(d.sampleSize)}</Td>
          <Td right>{formatNEff(d.nEff)}</Td>
          <Td right>{d.confidence === null ? '—' : <ConfidenceBar value={d.confidence} />}</Td>
          <Td className="min-w-56 text-slate-600">
            <span className="mb-1 flex flex-wrap gap-1">
              {d.change === 'new' ? <Badge tone="blue">New cell</Badge> : null}
              {d.change === 'removed' ? <Badge tone="red">Removed</Badge> : null}
              {d.wasClamped ? <Badge tone="amber">Clamped to bounds</Badge> : null}
              {d.wasStepLimited ? <Badge tone="amber">Step-limited</Badge> : null}
            </span>
            {d.note ? <span className="block text-xs">{d.note}</span> : null}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

// ---------------------------------------------------------------------------
// Active coefficients
// ---------------------------------------------------------------------------

function ActiveCoefficients({ data }: { data: Dashboard }) {
  const groups = groupByKind(data.activeCoefficients);
  return (
    <section className="space-y-3">
      <SectionHeading id="coefficients" title={data.activeSet ? `Active coefficients (v${data.activeSet.version})` : 'Active coefficients'}>
        What the pricing engine uses today. Prior is the starting value before any job data; n counts the job areas behind the value, n_eff
        discounts older ones, and confidence (0–100) combines the amount of evidence with how consistent it is.
      </SectionHeading>
      {!data.activeSet ? (
        <Alert tone="red">No active coefficient set. Pricing will not work until one is activated: restore a version from History.</Alert>
      ) : !groups.length ? (
        <Empty>The active set has no coefficients.</Empty>
      ) : (
        groups.map((g) => (
          <Card key={g.kind} className="p-0">
            <div className="border-b border-slate-200 p-4">
              <h3 className="font-semibold text-slate-900">{g.label}</h3>
              <p className="text-sm text-slate-600">{g.help}</p>
            </div>
            <Table
              minWidth="min-w-[760px]"
              head={
                <>
                  <Th>Applies to</Th>
                  <Th right>Value</Th>
                  <Th right>Prior</Th>
                  <Th right>Δ vs prior</Th>
                  <Th right>n</Th>
                  <Th right>n_eff</Th>
                  <Th right>Confidence</Th>
                  <Th right>± SE</Th>
                </>
              }
            >
              {g.rows.map((c) => (
                <tr key={`${c.product}/${c.jobType}/${c.accessLevel}`}>
                  <Td className="font-medium text-slate-800">
                    {scopeLabel(c, data.names)}
                    {c.wasClamped ? (
                      <span className="ml-2">
                        <Badge tone="amber">At bound</Badge>
                      </span>
                    ) : null}
                  </Td>
                  <Td right>
                    <span className="font-semibold text-slate-900">{formatCoef(c.value)}</span>
                    <span className="block text-xs text-slate-400">
                      range {formatCoef(c.lowerBound)}–{formatCoef(c.upperBound)}
                    </span>
                  </Td>
                  <Td right className="text-slate-500">
                    {formatCoef(c.priorValue)}
                  </Td>
                  <Td right>
                    <Change pct={pctChange(c.priorValue, c.value)} />
                  </Td>
                  <Td right>{formatCount(c.sampleSize)}</Td>
                  <Td right>{formatNEff(c.nEff)}</Td>
                  <Td right>
                    <ConfidenceBar value={c.confidence} />
                  </Td>
                  <Td right className="text-slate-500">
                    {formatStdError(c.stdError)}
                  </Td>
                </tr>
              ))}
            </Table>
          </Card>
        ))
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Estimate accuracy
// ---------------------------------------------------------------------------

const SPARK = { width: 240, height: 48, pad: 4 };

function AccuracySparkline({ points }: { points: Dashboard['accuracy'] }) {
  if (points.length < 2) return null;
  const oldestFirst = [...points].reverse();
  const hoursVals = oldestFirst.map((p) => p.report.hoursMapeModel);
  const qtyVals = oldestFirst.map((p) => p.report.qtyMapeModel);
  // Both lines share one zero-based scale so their heights compare.
  const all = [...hoursVals, ...qtyVals].filter((v): v is number => v !== null && Number.isFinite(v));
  const domain = [0, all.length ? Math.max(...all) : 0] as const;
  const hours = sparkline(hoursVals, { ...SPARK, zeroBased: true, domain });
  const qty = sparkline(qtyVals, { ...SPARK, zeroBased: true, domain });
  if (!hours && !qty) return null;
  const describe = (label: string, vals: Array<number | null>) => {
    const f = vals.filter((v): v is number => v !== null);
    return f.length >= 2 ? `${label} from ${formatMape(f[0])} to ${formatMape(f[f.length - 1])}` : null;
  };
  const summary = [describe('labor hours', hoursVals), describe('material', qtyVals)]
    .filter(Boolean)
    .join('; ');
  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
        className="h-12 w-full max-w-xs"
        role="img"
        aria-label={`Model error over the last ${points.length} runs: ${summary || 'not enough data'}.`}
      >
        <line x1={SPARK.pad} x2={SPARK.width - SPARK.pad} y1={SPARK.height - SPARK.pad} y2={SPARK.height - SPARK.pad} className="stroke-slate-200" strokeWidth={1} />
        {hours ? <path d={hours.path} fill="none" className="stroke-brand-600" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {qty ? <path d={qty.path} fill="none" className="stroke-amber-500" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray="4 3" /> : null}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 text-xs text-slate-500">
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-brand-600 align-middle" /> Labor hours
        </span>
        <span>
          <span className="mr-1 inline-block h-0.5 w-4 bg-amber-500 align-middle" /> Material
        </span>
        <span>Oldest left, newest right; lower is better.</span>
      </figcaption>
    </figure>
  );
}

function Accuracy({ data }: { data: Dashboard }) {
  const latest = data.accuracy[0];
  return (
    <section className="space-y-3">
      <SectionHeading id="accuracy" title="Estimate accuracy">
        How far predictions were from what crews actually used and worked, as a mean absolute percentage error (MAPE): the average of |predicted −
        actual| ÷ actual. 0% would be perfect.
      </SectionHeading>
      {!latest ? (
        <Empty>No accuracy numbers yet. They appear after a nightly run that has completed jobs with verified actuals.</Empty>
      ) : (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Stat label="Labor hours" sub={`Estimators: ${formatMape(latest.report.hoursMapeEstimator)}`}>
              Model off by {formatMape(latest.report.hoursMapeModel)}
            </Stat>
            <Stat label="Material quantity" sub={`Estimators: ${formatMape(latest.report.qtyMapeEstimator)}`}>
              Model off by {formatMape(latest.report.qtyMapeModel)}
            </Stat>
          </div>
          <div className="space-y-1 text-sm text-slate-700">
            {accuracySentences(latest.report).map((s) => (
              <p key={s}>{s}</p>
            ))}
            <p className="text-slate-500">
              Based on {formatCount(latest.report.n)} job {plural(latest.report.n, 'area')} with verified actuals, as of the run on{' '}
              {formatDate(latest.run.started_at)}. &ldquo;Estimators&rdquo; is what they quoted, including their own overrides.
            </p>
          </div>
          <AccuracySparkline points={data.accuracy} />
          <Table
            minWidth="min-w-[560px]"
            head={
              <>
                <Th>Run</Th>
                <Th right>Areas</Th>
                <Th right>Hours: model</Th>
                <Th right>Hours: estimators</Th>
                <Th right>Material: model</Th>
                <Th right>Material: estimators</Th>
              </>
            }
          >
            {data.accuracy.map(({ run, report }) => (
              <tr key={run.id}>
                <Td>{formatDate(run.started_at)}</Td>
                <Td right>{formatCount(report.n)}</Td>
                <Td right>{formatMape(report.hoursMapeModel)}</Td>
                <Td right>{formatMape(report.hoursMapeEstimator)}</Td>
                <Td right>{formatMape(report.qtyMapeModel)}</Td>
                <Td right>{formatMape(report.qtyMapeEstimator)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Win rate
// ---------------------------------------------------------------------------

function BucketTable({ title, hint, rows, label }: { title: string; hint?: string; rows: WinBuckets['byMarkup']; label?: (s: string) => string }) {
  return (
    <div className="min-w-0">
      <h4 className="font-semibold text-slate-900">{title}</h4>
      {hint ? <p className="mb-2 text-xs text-slate-500">{hint}</p> : null}
      {rows.length ? (
        <Table
          minWidth="min-w-[280px]"
          head={
            <>
              <Th />
              <Th right>Quotes</Th>
              <Th right>Wins</Th>
              <Th right>Win rate</Th>
            </>
          }
        >
          {rows.map((b) => (
            <tr key={b.label}>
              <Td className="font-medium text-slate-800">{label ? label(b.label) : b.label}</Td>
              <Td right>{formatCount(b.quotes)}</Td>
              <Td right>{formatCount(b.wins)}</Td>
              <Td right>{b.quotes ? formatPct(b.winRate) : '—'}</Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p className="text-sm text-slate-600">No decided quotes yet.</p>
      )}
    </div>
  );
}

function WinRate({ data }: { data: Dashboard }) {
  const { winModel, winRun, settings, names } = data;
  const buckets = winRun?.summary.buckets ?? null;
  const jobLabel = (code: string) => jobTypeLabel(code, names);
  return (
    <section className="space-y-3">
      <SectionHeading id="win-rate" title="Win rate and price recommendations">
        Every sent quote ends won, lost or expired. Once there are enough of them, a model learns how price affects the chance of winning and
        suggests the price with the best expected profit.
      </SectionHeading>
      <Card className="space-y-3">
        <h3 className="font-semibold text-slate-900">Price model</h3>
        {winModel ? (
          <>
            <div className="grid gap-4 sm:grid-cols-4">
              <Stat label="Trained" sub={`on ${formatCount(winModel.row.n_quotes)} decided ${plural(winModel.row.n_quotes, 'quote')}`}>
                {formatDate(winModel.row.trained_at)}
              </Stat>
              <Stat label="AUC" sub="How well it tells wins from losses: 0.5 is a coin flip, 1.0 is perfect.">
                {formatMetric(winModel.metrics.auc)}
              </Stat>
              <Stat label="Log loss" sub="Error of its win probabilities; lower is better.">
                {formatMetric(winModel.metrics.logLoss)}
              </Stat>
              <Stat label="Overall win rate" sub="Share of decided quotes that were won.">
                {formatPct(winModel.metrics.baseRate)}
              </Stat>
            </div>
            <p className="text-sm text-slate-600">Estimators see a recommended price with its win probability next to their own.</p>
            {winRun && !winRun.summary.trained && winRun.summary.reason ? (
              <p className="text-sm text-slate-500">
                The last run ({formatDate(winRun.row.started_at)}) kept this model: {winRun.summary.reason}
              </p>
            ) : null}
          </>
        ) : (
          <Alert tone="blue">{winColdStartMessage(settings.minQuotesForWinModel, winRun?.summary.nQuotes ?? null, winRun?.summary.reason ?? null)}</Alert>
        )}
      </Card>
      {buckets ? (
        <Card className="space-y-3">
          <p className="text-sm text-slate-600">
            From the run on {formatDate(winRun?.row.started_at)}
            {typeof winRun?.summary.nQuotes === 'number'
              ? `, over ${formatCount(winRun.summary.nQuotes)} decided ${plural(winRun.summary.nQuotes, 'quote')}.`
              : '.'}
          </p>
          <div className="grid gap-5 lg:grid-cols-3">
            <BucketTable title="By markup" hint="Markup = price ÷ loaded cost." rows={buckets.byMarkup} />
            <BucketTable title="By job type" rows={buckets.byJobType} label={jobLabel} />
            <BucketTable title="By lead source" rows={buckets.bySource} />
          </div>
        </Card>
      ) : (
        <Empty>Win rates by markup, job type and lead source appear after the first nightly run.</Empty>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// History, changelog, run log
// ---------------------------------------------------------------------------

function History({ data, isOwner }: { data: Dashboard; isOwner: boolean }) {
  return (
    <section className="space-y-3">
      <SectionHeading id="history" title="Version history">
        Every coefficient set ever created. Restoring a version copies it into a new active set; nothing is deleted or rewritten.
        {data.sets.length >= HISTORY_LIMIT ? ` Showing the latest ${HISTORY_LIMIT}.` : ''}
      </SectionHeading>
      {!data.sets.length ? (
        <Empty>No coefficient sets yet.</Empty>
      ) : (
        <Card className="p-0">
          <Table
            minWidth="min-w-[860px]"
            head={
              <>
                <Th>Version</Th>
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Created</Th>
                <Th>Activated</Th>
                <Th>Notes</Th>
                {isOwner ? <Th /> : null}
              </>
            }
          >
            {data.sets.map((s) => {
              const activatedBy = personName(data, s.activated_by);
              return (
                <tr key={s.id}>
                  <Td className="font-semibold text-slate-900">v{s.version}</Td>
                  <Td>
                    <Badge tone={SET_STATUS_TONES[s.status]}>{SET_STATUS_LABELS[s.status]}</Badge>
                  </Td>
                  <Td>
                    {setSourceLabel(s.source)}
                    {s.parent_id && s.source === 'rollback' ? <span className="block text-xs text-slate-500">copy of {versionLabel(data, s.parent_id)}</span> : null}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(s.created_at)}</Td>
                  <Td className="whitespace-nowrap">
                    {formatDateTime(s.activated_at)}
                    {activatedBy ? <span className="block text-xs text-slate-500">by {activatedBy}</span> : null}
                  </Td>
                  <Td className="min-w-56 whitespace-pre-line text-slate-600">{s.notes ?? '—'}</Td>
                  {isOwner ? (
                    <Td>
                      {canRestore(s.status) ? (
                        <RestoreSetButton action={restoreSet} setId={s.id} version={s.version} activeVersion={data.activeSet?.version ?? null} />
                      ) : null}
                    </Td>
                  ) : null}
                </tr>
              );
            })}
          </Table>
        </Card>
      )}
    </section>
  );
}

function Changelog({ data }: { data: Dashboard }) {
  return (
    <section className="space-y-3">
      <SectionHeading id="changelog" title="Changelog">
        One row per coefficient that moved when a set became active{data.changes.length >= CHANGELOG_LIMIT ? `; the latest ${CHANGELOG_LIMIT}` : ''}.
      </SectionHeading>
      {!data.changes.length ? (
        <Empty>No changes yet. Each approval, automatic promotion or restore adds a row for every coefficient that moved.</Empty>
      ) : (
        <Card className="p-0">
          <Table
            minWidth="min-w-[940px]"
            head={
              <>
                <Th>When</Th>
                <Th>Coefficient</Th>
                <Th right>Old → new</Th>
                <Th right>Change</Th>
                <Th>Reason</Th>
                <Th>By</Th>
                <Th>Sets</Th>
              </>
            }
          >
            {data.changes.map((c) => (
              <tr key={c.id}>
                <Td className="whitespace-nowrap">{formatDateTime(c.at)}</Td>
                <Td>
                  <span className="font-medium text-slate-800">{KIND_LABELS[c.kind]}</span>
                  <span className="block text-xs text-slate-500">{scopeLabel(c, data.names)}</span>
                </Td>
                <Td right>
                  <span className="whitespace-nowrap">
                    {formatCoef(c.oldValue)} → <span className="font-semibold text-slate-900">{formatCoef(c.newValue)}</span>
                  </span>
                </Td>
                <Td right>
                  <Change pct={c.pctChange ?? pctChange(c.oldValue, c.newValue)} />
                </Td>
                <Td className="min-w-56 text-slate-600">{c.reason}</Td>
                <Td>{personName(data, c.actorId) ?? 'Nightly job'}</Td>
                <Td className="whitespace-nowrap">
                  {versionLabel(data, c.fromSetId)} → {versionLabel(data, c.toSetId)}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </section>
  );
}

function RunLog({ data }: { data: Dashboard }) {
  return (
    <section className="space-y-3">
      <SectionHeading id="runs" title="Run log">
        The last {RUN_LOG_LIMIT} learning runs, nightly and by hand. A failed run never changes pricing.
      </SectionHeading>
      {!data.runs.length ? (
        <Empty>No learning runs yet. The first one runs tonight.</Empty>
      ) : (
        <Card className="p-0">
          <Table
            minWidth="min-w-[960px]"
            head={
              <>
                <Th>Run</Th>
                <Th>Started</Th>
                <Th right>Took</Th>
                <Th>Status</Th>
                <Th right>Considered</Th>
                <Th right>Used</Th>
                <Th>Result</Th>
              </>
            }
          >
            {data.runs.map(({ row: r, meta }) => {
              const by = personName(data, meta.actorId);
              const trigger = meta.trigger === 'manual' ? (by ? `Manual · ${by}` : 'Manual') : meta.trigger === 'cron' ? 'Nightly' : '';
              const win = r.kind === 'win_model' ? parseWinRunSummary(r.summary) : null;
              const result = meta.message ?? win?.reason ?? null;
              return (
                <tr key={r.id}>
                  <Td>
                    <span className="font-medium text-slate-800">{runKindLabel(r.kind)}</span>
                    <span className="block text-xs text-slate-500">{trigger}</span>
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(r.started_at)}</Td>
                  <Td right>{formatDuration(r.started_at, r.finished_at) ?? '—'}</Td>
                  <Td>
                    <RunStatusBadge status={r.status} />
                  </Td>
                  <Td right>{r.jobs_considered === null ? '—' : formatCount(r.jobs_considered)}</Td>
                  <Td right>{r.jobs_used === null ? '—' : formatCount(r.jobs_used)}</Td>
                  <Td className="min-w-64 text-slate-600">
                    <span className="mb-1 flex flex-wrap gap-1">
                      {r.promoted ? <Badge tone="green">Promoted</Badge> : null}
                      {meta.outcome && !r.promoted ? <Badge>{outcomeLabel(meta.outcome)}</Badge> : null}
                      {win?.trained ? <Badge tone="green">Trained</Badge> : null}
                      {r.candidate_set_id ? <Badge tone="slate">Candidate {versionLabel(data, r.candidate_set_id)}</Badge> : null}
                    </span>
                    {result ? <span className="block text-xs">{result}</span> : null}
                    {r.error ? <span className="block text-xs text-red-700">{r.error}</span> : null}
                  </Td>
                </tr>
              );
            })}
          </Table>
        </Card>
      )}
    </section>
  );
}
