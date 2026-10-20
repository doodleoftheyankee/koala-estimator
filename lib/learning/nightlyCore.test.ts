import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { priceEstimate, type PricedOption, type WinModel } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { seedActive } from './__fixtures__/synthetic';
import type { NightlySummary } from './nightly';
import {
  assembleJobsForLearning,
  businessDate,
  candidateSetRow,
  chunk,
  coefficientRow,
  coefficientRowSchema,
  cronAuthorized,
  decideEstimates,
  lineFlagOutcomes,
  nightlyFailureEmail,
  parseLearningSnapshot,
  parseLineFlagKey,
  parseOutcomeSnapshot,
  parseRows,
  runNightlyWith,
  summaryHasFailures,
  toStoredCoefficient,
  verifiedActualsByJob,
  winModelRow,
  type ActualDbRow,
  type CompletedJobRow,
  type EmailOut,
  type FlagRow,
  type LearningRows,
  type NightlyDeps,
  type OutcomeEstimateRow,
  type OutcomeQuoteRow,
  type RunFinish,
  type RunKind,
} from './nightlyCore';
import type { JobForLearning, QuoteOutcomeRow } from './observations';
import { DEFAULT_LEARNING_SETTINGS } from './settings';
import type { CalibrationResult, CandidateCoefficient, GateResult, LearningSettings } from './types';

const NOW = new Date('2026-10-21T07:15:00Z'); // 3:15 AM Eastern on Oct 21
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const actual = (patch: Partial<ActualDbRow> = {}): ActualDbRow => ({
  job_id: 'job-1',
  area_id: 'a1',
  product: 'cellulose',
  actual_material_qty: 92,
  actual_hours: 20,
  actual_drive_minutes: null,
  verified_at: '2026-10-02T15:00:00Z',
  exclude_from_learning: false,
  ...patch,
});

const priced = priceEstimate(estimate({ areas: [area()] }), snapshot, coefficients);
const frozenInput = {
  areas: [{ id: 'a1', name: 'Main attic', jobType: 'attic' as const, accessLevel: 'easy' as const, sqft: 1000 }],
  driveMinutesOneWay: 20,
};

/** A completed attic job priced by the real engine, actuals = model x factor. */
function syntheticJob(i: number, opts: { hours?: number; qty?: number; ageDays?: number } = {}): JobForLearning {
  const sqft = 800 + 40 * i;
  const areaId = `a${i}`;
  const options = priceEstimate(estimate({ areas: [area({ id: areaId, sqft })] }), snapshot, coefficients).options;
  const better = options.find((o) => o.tier === 'better')!;
  const labor = better.lines.find((l) => l.product === 'cellulose' && l.kind === 'labor')!;
  const material = better.lines.find((l) => l.product === 'cellulose' && l.kind === 'material')!;
  const wobble = 1 + ((i % 5) - 2) / 100;
  return {
    jobId: `job-${String(i).padStart(2, '0')}`,
    completedAt: daysAgo(opts.ageDays ?? 200 - i * 6),
    signedTier: 'better',
    snapshot: { options, input: { areas: [{ id: areaId, name: 'Attic', jobType: 'attic', accessLevel: 'easy', sqft }], driveMinutesOneWay: 20 } },
    areasFallback: [],
    actuals: [
      {
        areaId,
        product: 'cellulose',
        actualMaterialQty: material.modelQty! * (opts.qty ?? 1.12) * wobble,
        actualHours: labor.modelHours! * (opts.hours ?? 1.3) * wobble,
        actualDriveMinutes: null,
      },
      { areaId: null, product: null, actualMaterialQty: null, actualHours: null, actualDriveMinutes: 26 + (i % 4) },
    ],
    driveMinutesEstFallback: null,
  };
}

const goodHistory = () => Array.from({ length: 30 }, (_, i) => syntheticJob(i));
/** Older jobs inflated, newest ones exactly as the active model says: the backtest must fail. */
const corruptedHistory = () =>
  Array.from({ length: 30 }, (_, i) => syntheticJob(i, i < 24 ? { hours: 1.6, qty: 1.4 } : { hours: 1, qty: 1 }));

const gate = (name: GateResult['name'], passed = true): GateResult => ({ name, passed, detail: `${name} detail` });
const allGates = (fail: GateResult['name'][] = []): GateResult[] =>
  (['sanity', 'bounds', 'step_limit', 'min_evidence', 'backtest'] as const).map((n) => gate(n, !fail.includes(n)));

const candidate = (patch: Partial<CandidateCoefficient> = {}): CandidateCoefficient => ({
  kind: 'waste_factor',
  product: 'cellulose',
  jobType: null,
  accessLevel: null,
  value: 1.1234567,
  priorValue: 1.08,
  lowerBound: 1,
  upperBound: 1.6,
  sampleSize: 14,
  nEff: 12.3456,
  confidence: 81.236,
  stdError: 0.01234567,
  wasClamped: false,
  wasStepLimited: true,
  changed: true,
  note: 'n_eff 12.35, raw 1.17, step-limited to 1.12',
  ...patch,
});

const stubResult = (patch: Partial<CalibrationResult> = {}): CalibrationResult => ({
  coefficients: [candidate(), candidate({ kind: 'drive_time_factor', product: null, changed: false, note: 'unchanged' })],
  changedCount: 1,
  gates: allGates(),
  passed: true,
  autoPromotable: true,
  metrics: { nObservations: 40, nUsed: 38, holdout: null },
  ...patch,
});

/** Decided quote with a recommended 'better' option at the given markup. */
function quoteRow(i: number, won: boolean, markup: number): QuoteOutcomeRow {
  const loadedCost = 3000 + 50 * i;
  const option = { tier: 'better', price: Math.round(loadedCost * markup), loadedCost } as unknown as PricedOption;
  return {
    estimateId: `est-${i}`,
    won,
    decidedAt: daysAgo(i),
    source: i % 2 ? 'Website' : 'Referral',
    signedTier: won ? 'better' : null,
    snapshot: {
      document: { recommendedTier: 'better' },
      options: [option],
      input: { areas: [{ id: 'a', name: 'Attic', jobType: 'attic', accessLevel: 'easy', sqft: 900 + 10 * i }], driveMinutesOneWay: 20 },
    },
  };
}

/** 60 decided quotes: cheaper quotes win more often. */
const decidedQuotes = () =>
  Array.from({ length: 60 }, (_, i) => {
    const markup = 1.3 + (i % 10) * 0.08;
    return quoteRow(i, (i * 7) % 10 >= (markup - 1.3) * 12, markup);
  });

interface Harness {
  deps: NightlyDeps;
  started: Array<{ kind: RunKind; summary: Record<string, unknown> }>;
  finished: Array<{ runId: string; finish: RunFinish }>;
  emails: EmailOut[];
  logs: string[];
  insertCandidateSet: ReturnType<typeof vi.fn<NightlyDeps['insertCandidateSet']>>;
  rejectSet: ReturnType<typeof vi.fn<NightlyDeps['rejectSet']>>;
  promoteSet: ReturnType<typeof vi.fn<NightlyDeps['promoteSet']>>;
  insertWinModel: ReturnType<typeof vi.fn<NightlyDeps['insertWinModel']>>;
}

function harness(over: Partial<NightlyDeps> = {}, settings: Partial<LearningSettings> = {}): Harness {
  const started: Harness['started'] = [];
  const finished: Harness['finished'] = [];
  const emails: EmailOut[] = [];
  const logs: string[] = [];
  let seq = 0;
  const insertCandidateSet = vi.fn<NightlyDeps['insertCandidateSet']>(async () => 'set-new');
  const rejectSet = vi.fn<NightlyDeps['rejectSet']>(async () => {});
  const promoteSet = vi.fn<NightlyDeps['promoteSet']>(async () => {});
  const insertWinModel = vi.fn<NightlyDeps['insertWinModel']>(async () => 'model-new');
  const deps: NightlyDeps = {
    loadSettings: async () => ({ ...DEFAULT_LEARNING_SETTINGS, autoPromote: true, ...settings }),
    expireStaleQuotes: async () => 2,
    startRun: async (kind, summary) => {
      started.push({ kind, summary });
      return `run-${++seq}`;
    },
    finishRun: async (runId, finish) => {
      finished.push({ runId, finish });
    },
    loadActiveCoefficients: async () => ({ setId: 'set-active', version: 3, coefficients: seedActive() }),
    loadActiveSetId: async () => 'set-active',
    loadJobsForLearning: async () => [],
    insertCandidateSet,
    rejectSet,
    promoteSet,
    loadDecidedQuotes: async () => [],
    insertWinModel,
    updateDeviationOutcomes: async () => 4,
    ownerEmail: 'owner@example.com',
    sendEmail: async (msg) => {
      emails.push(msg);
    },
    clock: () => new Date('2026-10-21T07:16:30Z'),
    log: (m) => {
      logs.push(m);
    },
    ...over,
  };
  return { deps, started, finished, emails, logs, insertCandidateSet, rejectSet, promoteSet, insertWinModel };
}

const finishOf = (h: Harness, kind: RunKind) => {
  const i = h.started.findIndex((s) => s.kind === kind);
  return h.finished.find((f) => f.runId === `run-${i + 1}`)?.finish;
};

// ---------------------------------------------------------------------------
// Parsing at the database boundary
// ---------------------------------------------------------------------------

describe('row parsing', () => {
  it('accepts numeric columns as numbers or strings and maps coefficients', () => {
    const [row] = parseRows(
      coefficientRowSchema,
      [
        {
          kind: 'labor_hrs_per_unit',
          product: 'cellulose',
          job_type: 'attic',
          access_level: null,
          value: '0.165000',
          prior_value: 0.15,
          lower_bound: '0.02',
          upper_bound: '1',
          sample_size: 12,
          n_eff: '10.50',
          confidence: '72.10',
        },
      ],
      'coefficient',
    );
    expect(toStoredCoefficient(row!)).toEqual({
      kind: 'labor_hrs_per_unit',
      product: 'cellulose',
      jobType: 'attic',
      accessLevel: null,
      value: 0.165,
      priorValue: 0.15,
      lowerBound: 0.02,
      upperBound: 1,
      sampleSize: 12,
      nEff: 10.5,
      confidence: 72.1,
    });
  });

  it('names the table, row and field of the first problem', () => {
    expect(() => parseRows(coefficientRowSchema, [{ kind: 'nope' }], 'coefficient')).toThrow(/Unexpected coefficient row #1 \(kind\)/);
    expect(() => parseRows(coefficientRowSchema, [null], 'coefficient')).toThrow(/Unexpected coefficient row #1: /);
  });
});

describe('parseLearningSnapshot', () => {
  it('keeps priced options and the frozen input', () => {
    const s = parseLearningSnapshot({ options: priced.options, input: frozenInput, document: { x: 1 } });
    expect(s.options).toHaveLength(priced.options.length);
    expect(s.options[0]!.lines[0]).toEqual(priced.options[0]!.lines[0]); // passthrough keeps every field
    expect(s.input).toEqual(frozenInput);
  });

  it('drops a malformed input (estimate_areas is the fallback) and malformed options', () => {
    expect(parseLearningSnapshot({ options: priced.options, input: { areas: [{ id: 'a1' }] } })).not.toHaveProperty('input');
    expect(parseLearningSnapshot({ options: [{ tier: 'better' }] }).options).toEqual([]);
    expect(parseLearningSnapshot({ options: [{ tier: 'platinum', lines: [] }] }).options).toEqual([]);
    expect(parseLearningSnapshot(null)).toEqual({ options: [] });
    expect(parseLearningSnapshot([1, 2])).toEqual({ options: [] });
    expect(parseLearningSnapshot('{"options":[]}')).toEqual({ options: [] });
  });

  it('accepts Phase 1 lines without areaId/product keys', () => {
    expect(parseLearningSnapshot({ options: [{ tier: 'good', lines: [{ kind: 'drive' }] }] }).options).toHaveLength(1);
  });
});

describe('parseOutcomeSnapshot', () => {
  it('keeps the recommended tier, options and input', () => {
    const s = parseOutcomeSnapshot({ document: { recommendedTier: 'best', other: 1 }, options: priced.options, input: frozenInput });
    expect(s.document).toEqual({ recommendedTier: 'best' });
    expect(s.options).toHaveLength(3);
    expect(s.input).toEqual(frozenInput);
  });

  it('drops parts it cannot trust', () => {
    expect(parseOutcomeSnapshot({ document: { recommendedTier: 'gold' }, options: 'x', input: 3 })).toEqual({});
    expect(parseOutcomeSnapshot(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Jobs for learning
// ---------------------------------------------------------------------------

describe('verifiedActualsByJob', () => {
  it('keeps jobs whose every actual is verified', () => {
    const rows = [
      actual({ job_id: 'j1' }),
      actual({ job_id: 'j1', product: 'air_sealing' }),
      actual({ job_id: 'j2' }),
      actual({ job_id: 'j2', product: 'removal', verified_at: null }),
    ];
    const m = verifiedActualsByJob(rows);
    expect([...m.keys()]).toEqual(['j1']);
    expect(m.get('j1')).toHaveLength(2);
    expect(verifiedActualsByJob([]).size).toBe(0);
  });
});

describe('assembleJobsForLearning', () => {
  const base = (): LearningRows => ({
    jobs: [{ id: 'job-1', quote_id: 'q1', estimate_id: 'e1', completed_at: '2026-10-01T16:00:00Z' }],
    actuals: [
      actual(),
      actual({ product: 'air_sealing', actual_material_qty: 900, actual_hours: 7.5, exclude_from_learning: true }),
      actual({ area_id: null, product: null, actual_material_qty: null, actual_hours: null, actual_drive_minutes: 32 }),
    ],
    quotes: [{ id: 'q1', signed_tier: 'better', snapshot: { options: priced.options, input: frozenInput } }],
    areas: [{ id: 'a1', estimate_id: 'e1', name: 'Main attic', job_type: 'attic', access_level: 'easy', sqft: 1000 }],
    estimates: [{ id: 'e1', drive_minutes_est: 18 }],
  });

  it('builds JobForLearning with excluded actuals dropped and the fallbacks filled', () => {
    const [job] = assembleJobsForLearning(base());
    expect(job).toMatchObject({
      jobId: 'job-1',
      completedAt: '2026-10-01T16:00:00Z',
      signedTier: 'better',
      areasFallback: [{ id: 'a1', name: 'Main attic', jobType: 'attic', accessLevel: 'easy', sqft: 1000 }],
      driveMinutesEstFallback: 18,
    });
    expect(job!.actuals).toEqual([
      { areaId: 'a1', product: 'cellulose', actualMaterialQty: 92, actualHours: 20, actualDriveMinutes: null },
      { areaId: null, product: null, actualMaterialQty: null, actualHours: null, actualDriveMinutes: 32 },
    ]);
    expect(job!.snapshot.input).toEqual(frozenInput);
    expect(job!.snapshot.options).toHaveLength(3);
  });

  it('skips jobs with unverified or no actuals, a missing quote or no signed tier', () => {
    const rows = base();
    rows.jobs.push(
      { id: 'job-2', quote_id: 'q1', estimate_id: 'e1', completed_at: null }, // no actuals at all
      { id: 'job-3', quote_id: 'q-missing', estimate_id: 'e1', completed_at: null },
      { id: 'job-4', quote_id: 'q4', estimate_id: 'e1', completed_at: null },
      { id: 'job-5', quote_id: 'q1', estimate_id: 'e1', completed_at: null },
    );
    rows.actuals.push(actual({ job_id: 'job-3' }), actual({ job_id: 'job-4' }), actual({ job_id: 'job-5', verified_at: null }));
    rows.quotes.push({ id: 'q4', signed_tier: null, snapshot: {} });
    expect(assembleJobsForLearning(rows).map((j) => j.jobId)).toEqual(['job-1']);
  });

  it('falls back to the latest verification time and sorts by completion', () => {
    const rows = base();
    rows.jobs.unshift({ id: 'job-0', quote_id: 'q1', estimate_id: 'e-unknown', completed_at: null });
    rows.actuals.push(
      actual({ job_id: 'job-0', verified_at: '2026-09-01T12:00:00Z' }),
      actual({ job_id: 'job-0', product: 'removal', verified_at: '2026-09-03T12:00:00Z' }),
    );
    const jobs = assembleJobsForLearning(rows);
    expect(jobs.map((j) => [j.jobId, j.completedAt])).toEqual([
      ['job-0', '2026-09-03T12:00:00Z'],
      ['job-1', '2026-10-01T16:00:00Z'],
    ]);
    expect(jobs[0]!.areasFallback).toEqual([]);
    expect(jobs[0]!.driveMinutesEstFallback).toBeNull();
  });

  it('skips a job with no completion time and no parseable verification time', () => {
    const rows = base();
    rows.jobs = [{ id: 'job-1', quote_id: 'q1', estimate_id: 'e1', completed_at: null }];
    rows.actuals = [actual({ verified_at: 'not a date' })];
    expect(assembleJobsForLearning(rows)).toEqual([]);
  });

  it('orders jobs completed at the same moment by id', () => {
    const rows = base();
    rows.jobs = ['job-b', 'job-a'].map((id) => ({ id, quote_id: 'q1', estimate_id: 'e1', completed_at: '2026-10-01T16:00:00Z' }));
    rows.actuals = [actual({ job_id: 'job-b' }), actual({ job_id: 'job-a' })];
    expect(assembleJobsForLearning(rows).map((j) => j.jobId)).toEqual(['job-a', 'job-b']);
  });
});

// ---------------------------------------------------------------------------
// Decided quotes
// ---------------------------------------------------------------------------

describe('decideEstimates', () => {
  const q = (patch: Partial<OutcomeQuoteRow>): OutcomeQuoteRow => ({
    id: 'q',
    estimate_id: 'e',
    version: 1,
    status: 'sent',
    signed_at: null,
    signed_tier: null,
    expires_at: '2026-09-30T04:00:00Z',
    ...patch,
  });
  const e = (patch: Partial<OutcomeEstimateRow>): OutcomeEstimateRow => ({
    id: 'e',
    status: 'sent',
    decided_at: null,
    lead_id: null,
    ...patch,
  });
  const sources = [
    { id: 's1', name: 'Website' },
    { id: 's2', name: 'Referral' },
  ];

  it('classifies wins, losses, expiries and declines; leaves undecided and voided estimates out', () => {
    const decided = decideEstimates({
      quotes: [
        // e1: v1 signed (won), v2 newer but superseded-style row
        q({ id: 'q1a', estimate_id: 'e1', version: 1, status: 'signed', signed_at: '2026-09-10T15:00:00Z', signed_tier: 'best' }),
        q({ id: 'q1b', estimate_id: 'e1', version: 2, status: 'superseded' }),
        // e2: marked lost by the office
        q({ id: 'q2', estimate_id: 'e2', status: 'sent' }),
        // e3: latest expired, decided_at from expire_stale_quotes
        q({ id: 'q3a', estimate_id: 'e3', version: 1, status: 'superseded' }),
        q({ id: 'q3b', estimate_id: 'e3', version: 2, status: 'expired', expires_at: '2026-10-01T04:00:00Z' }),
        // e4: declined, no decided_at -> expiry
        q({ id: 'q4', estimate_id: 'e4', status: 'declined', expires_at: '2026-10-05T04:00:00Z' }),
        // e5: still open
        q({ id: 'q5', estimate_id: 'e5', status: 'viewed' }),
        // e6: older version expired but a newer one is open: undecided
        q({ id: 'q6a', estimate_id: 'e6', version: 1, status: 'expired' }),
        q({ id: 'q6b', estimate_id: 'e6', version: 2, status: 'sent' }),
        // e7: voided after expiry: not a customer's decision
        q({ id: 'q7', estimate_id: 'e7', status: 'expired' }),
        // e8: no estimate row visible (defensive): decided by quote status alone
        q({ id: 'q8', estimate_id: 'e8', status: 'declined' }),
      ],
      estimates: [
        e({ id: 'e1', status: 'signed', decided_at: '2026-09-11T00:00:00Z', lead_id: 'l1' }),
        e({ id: 'e2', status: 'lost', decided_at: '2026-09-20T18:00:00Z', lead_id: 'l2' }),
        e({ id: 'e3', status: 'expired', decided_at: '2026-10-01T07:15:00Z', lead_id: 'l-missing' }),
        e({ id: 'e4', status: 'sent', lead_id: 'l3' }),
        e({ id: 'e5', status: 'viewed' }),
        e({ id: 'e6', status: 'sent' }),
        e({ id: 'e7', status: 'void' }),
      ],
      leads: [
        { id: 'l1', source_id: 's1' },
        { id: 'l2', source_id: 's2' },
        { id: 'l3', source_id: null },
      ],
      sources,
    });
    expect(decided).toEqual([
      { estimateId: 'e1', quoteId: 'q1a', won: true, decidedAt: '2026-09-10T15:00:00Z', source: 'Website', signedTier: 'best' },
      { estimateId: 'e2', quoteId: 'q2', won: false, decidedAt: '2026-09-20T18:00:00Z', source: 'Referral', signedTier: null },
      { estimateId: 'e3', quoteId: 'q3b', won: false, decidedAt: '2026-10-01T07:15:00Z', source: null, signedTier: null },
      { estimateId: 'e4', quoteId: 'q4', won: false, decidedAt: '2026-10-05T04:00:00Z', source: null, signedTier: null },
      { estimateId: 'e8', quoteId: 'q8', won: false, decidedAt: '2026-09-30T04:00:00Z', source: null, signedTier: null },
    ]);
  });

  it('a voided estimate that was signed still counts as won; signed_at falls back to decided_at, then expiry', () => {
    const decided = decideEstimates({
      quotes: [
        q({ id: 'qa', estimate_id: 'ea', status: 'signed' }),
        q({ id: 'qb', estimate_id: 'eb', status: 'signed' }),
      ],
      estimates: [e({ id: 'ea', status: 'void', decided_at: '2026-09-01T00:00:00Z' }), e({ id: 'eb', status: 'signed' })],
      leads: [],
      sources,
    });
    expect(decided.map((d) => [d.estimateId, d.won, d.decidedAt])).toEqual([
      ['ea', true, '2026-09-01T00:00:00Z'],
      ['eb', true, '2026-09-30T04:00:00Z'],
    ]);
  });

  it('property: one row per decided estimate, won iff any version is signed', () => {
    const statuses = ['sent', 'viewed', 'signed', 'declined', 'expired', 'superseded'] as const;
    const arb = fc.array(
      fc.record({ estimate: fc.integer({ min: 0, max: 5 }), version: fc.integer({ min: 1, max: 4 }), status: fc.constantFrom(...statuses) }),
      { maxLength: 30 },
    );
    fc.assert(
      fc.property(arb, fc.constantFrom('sent', 'lost', 'void', 'expired'), (rows, estStatus) => {
        const quotes = rows.map((r, i) =>
          q({ id: `q${i}`, estimate_id: `e${r.estimate}`, version: r.version + i / 100, status: r.status }),
        );
        const estimates = [...new Set(quotes.map((x) => x.estimate_id))].map((id) => e({ id, status: estStatus }));
        const decided = decideEstimates({ quotes, estimates, leads: [], sources: [] });
        expect(new Set(decided.map((d) => d.estimateId)).size).toBe(decided.length);
        for (const d of decided) {
          const versions = quotes.filter((x) => x.estimate_id === d.estimateId);
          expect(d.won).toBe(versions.some((x) => x.status === 'signed'));
          expect(versions.map((x) => x.id)).toContain(d.quoteId);
        }
        if (estStatus === 'lost') {
          // Every non-void estimate the office marked lost is decided.
          expect(decided).toHaveLength(estimates.length);
        }
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Deviation flag outcomes
// ---------------------------------------------------------------------------

describe('parseLineFlagKey', () => {
  it('reads lineKey|metric for qty on material lines and hours on labor/removal lines', () => {
    expect(parseLineFlagKey('a1|cellulose|material|qty')).toEqual({ areaId: 'a1', product: 'cellulose', kind: 'material', metric: 'qty' });
    expect(parseLineFlagKey('a1|cellulose|labor|hours')).toEqual({ areaId: 'a1', product: 'cellulose', kind: 'labor', metric: 'hours' });
    expect(parseLineFlagKey('a1|removal|removal|hours')).toMatchObject({ product: 'removal', kind: 'removal' });
  });

  it('rejects totals, legacy flags and inconsistent keys', () => {
    for (const k of [
      null,
      '',
      'better|total_price',
      'a1|cellulose|material',
      'a1|cellulose|material|qty|x',
      '|cellulose|material|qty',
      'a1|vermiculite|material|qty',
      'a1|cellulose|drive|hours',
      'a1|cellulose|material|cost',
      'a1|cellulose|material|hours',
      'a1|cellulose|labor|qty',
    ]) {
      expect(parseLineFlagKey(k)).toBeNull();
    }
  });
});

describe('lineFlagOutcomes', () => {
  const flag = (patch: Partial<FlagRow>): FlagRow => ({
    id: 'f1',
    estimate_id: 'e1',
    flag_key: 'a1|cellulose|labor|hours',
    metric: 'hours',
    estimator_value: 14,
    model_value: 10,
    ...patch,
  });
  const job = (patch: Partial<CompletedJobRow> = {}): CompletedJobRow => ({
    id: 'job-1',
    estimate_id: 'e1',
    completed_at: '2026-10-01T16:00:00Z',
    ...patch,
  });

  it('scores hours and quantity flags against the crew actuals', () => {
    const out = lineFlagOutcomes(
      [
        flag({ id: 'hours-est' }), // actual 13.5: estimator (14) closer than model (10)
        flag({ id: 'qty-model', flag_key: 'a1|cellulose|material|qty', metric: 'qty', estimator_value: 120, model_value: 90 }), // actual 92
        flag({ id: 'tie', flag_key: 'a1|air_sealing|labor|hours', estimator_value: 8.1, model_value: 7.9 }), // actual 8
      ],
      [job()],
      [
        actual({ actual_hours: 13.5, actual_material_qty: 92 }),
        actual({ product: 'air_sealing', actual_hours: 8, actual_material_qty: 900 }),
      ],
    );
    expect(out).toEqual([
      { id: 'hours-est', outcome: 'estimator_closer' },
      { id: 'qty-model', outcome: 'model_closer' },
      { id: 'tie', outcome: 'tie' },
    ]);
  });

  it('gives no outcome without a usable, verified, included actual', () => {
    const flags = [
      flag({ id: 'total', flag_key: 'better|total_price', metric: 'total_price' }),
      flag({ id: 'metric-mismatch', metric: 'qty' }),
      flag({ id: 'no-row', flag_key: 'a2|cellulose|labor|hours' }),
      flag({ id: 'excluded', flag_key: 'a1|removal|removal|hours' }),
      flag({ id: 'zero', flag_key: 'a1|batts|labor|hours' }),
      flag({ id: 'null-actual', flag_key: 'a1|batts|material|qty', metric: 'qty' }),
      flag({ id: 'no-job', estimate_id: 'e9' }),
      flag({ id: 'unverified', estimate_id: 'e2' }),
    ];
    const out = lineFlagOutcomes(
      flags,
      [job(), job({ id: 'job-2', estimate_id: 'e2' })],
      [
        actual({ actual_hours: 13.5 }),
        actual({ product: 'removal', actual_hours: 30, exclude_from_learning: true }),
        actual({ product: 'batts', actual_hours: 0, actual_material_qty: null }),
        actual({ job_id: 'job-2', verified_at: null }),
      ],
    );
    expect(out).toEqual([]);
  });

  it('uses the most recently completed verified job of the estimate', () => {
    const out = lineFlagOutcomes(
      [flag({})],
      [
        job({ id: 'job-old', completed_at: '2026-09-01T16:00:00Z' }),
        job({ id: 'job-new', completed_at: '2026-10-05T16:00:00Z' }),
        job({ id: 'job-undated', completed_at: null }),
      ],
      [
        actual({ job_id: 'job-old', actual_hours: 10 }), // would favor the model
        actual({ job_id: 'job-new', actual_hours: 14 }), // favors the estimator
        actual({ job_id: 'job-undated', actual_hours: 10 }),
      ],
    );
    expect(out).toEqual([{ id: 'f1', outcome: 'estimator_closer' }]);

    // Same completion time: the larger id wins, deterministically.
    const tie = lineFlagOutcomes(
      [flag({})],
      [job({ id: 'job-a' }), job({ id: 'job-b' })],
      [actual({ job_id: 'job-a', actual_hours: 10 }), actual({ job_id: 'job-b', actual_hours: 14 })],
    );
    expect(tie).toEqual([{ id: 'f1', outcome: 'estimator_closer' }]);
  });
});

// ---------------------------------------------------------------------------
// Rows written
// ---------------------------------------------------------------------------

describe('coefficientRow', () => {
  it('rounds values to 6 dp and n_eff/confidence to 2 dp', () => {
    expect(coefficientRow('set-1', candidate())).toEqual({
      set_id: 'set-1',
      kind: 'waste_factor',
      product: 'cellulose',
      job_type: null,
      access_level: null,
      value: 1.123457,
      prior_value: 1.08,
      lower_bound: 1,
      upper_bound: 1.6,
      std_error: 0.012346,
      sample_size: 14,
      n_eff: 12.35,
      confidence: 81.24,
      was_clamped: false,
      was_step_limited: true,
    });
  });

  it('stores unknown evidence as zero/null and keeps confidence within 0..100', () => {
    const row = coefficientRow('s', candidate({ stdError: null, sampleSize: Number.NaN, nEff: Infinity, confidence: 100.004 }));
    expect(row).toMatchObject({ std_error: null, sample_size: 0, n_eff: 0, confidence: 100 });
    expect(coefficientRow('s', candidate({ stdError: Number.NaN, confidence: Number.NaN }))).toMatchObject({ std_error: null, confidence: 0 });
    expect(coefficientRow('s', candidate({ confidence: -3, nEff: -1, sampleSize: -2 }))).toMatchObject({ confidence: 0, n_eff: 0, sample_size: 0 });
  });

  it('refuses a value the column cannot hold, naming the coefficient', () => {
    expect(() => coefficientRow('s', candidate({ value: Number.NaN }))).toThrow('Candidate waste_factor(cellulose/*/*) value is not a finite number');
    expect(() => coefficientRow('s', candidate({ upperBound: Infinity }))).toThrow(/upper bound is not a finite number/);
    expect(() => coefficientRow('s', candidate({ priorValue: 1e9 }))).toThrow(/prior \(1000000000\) is too large to store/);
  });

  it('clips evidence into its column and drops an unstorable standard error', () => {
    expect(coefficientRow('s', candidate({ nEff: 1e12, sampleSize: 1e12, stdError: 1e9 }))).toMatchObject({
      n_eff: 99_999_999.99,
      sample_size: 2_147_483_647,
      std_error: null,
    });
  });

  it('property: every stored number fits its column (numeric(14,6), numeric(10,2), numeric(5,2) 0..100, int)', () => {
    fc.assert(
      fc.property(fc.double(), fc.double(), fc.double(), fc.option(fc.double()), (conf, nEff, n, se) => {
        const row = coefficientRow('s', candidate({ confidence: conf, nEff, sampleSize: n, stdError: se }));
        const confidence = row.confidence as number;
        const neff = row.n_eff as number;
        const size = row.sample_size as number;
        expect(confidence >= 0 && confidence <= 100).toBe(true);
        expect(neff >= 0 && neff <= 99_999_999.99).toBe(true);
        expect(Number.isInteger(size) && size >= 0 && size <= 2_147_483_647).toBe(true);
        expect(row.std_error === null || Math.abs(row.std_error as number) <= 99_999_999.999999).toBe(true);
      }),
    );
  });
});

describe('candidateSetRow', () => {
  it('describes the candidate with metrics, gate results and changelog notes', () => {
    const row = candidateSetRow({ runId: 'run-1', parentSetId: 'set-active', result: stubResult() });
    expect(row).toEqual({
      status: 'candidate',
      source: 'nightly',
      parent_id: 'set-active',
      learning_run_id: 'run-1',
      metrics: {
        holdout: null,
        nObservations: 40,
        nUsed: 38,
        changedCount: 1,
        notes: [{ kind: 'waste_factor', product: 'cellulose', jobType: null, accessLevel: null, note: 'n_eff 12.35, raw 1.17, step-limited to 1.12' }],
      },
      gate_results: { gates: allGates() },
      notes: 'Nightly calibration: 1 coefficient changed from 38 of 40 observations.',
    });
    expect(candidateSetRow({ runId: 'r', parentSetId: 'p', result: stubResult({ changedCount: 3 }) }).notes).toMatch(/3 coefficients changed/);
  });
});

describe('winModelRow', () => {
  it('stores params the way lib/server/snapshot.ts parses them, inactive', () => {
    const model: Omit<WinModel, 'id' | 'trainedAt'> = {
      nQuotes: 55,
      weights: { intercept: 1, markup: -2 },
      jobTypes: ['attic'],
      sources: ['Website'],
      metrics: { logLoss: 0.6, auc: 0.7, baseRate: 0.4 },
    };
    expect(winModelRow('run-2', model)).toEqual({
      learning_run_id: 'run-2',
      n_quotes: 55,
      params: { weights: { intercept: 1, markup: -2 }, jobTypes: ['attic'], sources: ['Website'] },
      metrics: { logLoss: 0.6, auc: 0.7, baseRate: 0.4 },
      is_active: false,
    });
  });
});

describe('chunk', () => {
  it('splits in order and never loses an item', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 50 }), (xs, n) => {
        const parts = chunk(xs, n);
        expect(parts.flat()).toEqual(xs);
        expect(parts.every((p) => p.length > 0 && p.length <= n)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Cron authorization
// ---------------------------------------------------------------------------

describe('cronAuthorized', () => {
  it('accepts exactly `Bearer <secret>`', () => {
    expect(cronAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    for (const h of [null, '', 'Bearer s3cre', 'Bearer s3cret ', 'bearer s3cret', 's3cret', 'Bearer  s3cret', 'Basic s3cret']) {
      expect(cronAuthorized(h, 's3cret')).toBe(false);
    }
  });

  it('never authorizes with an empty secret', () => {
    expect(cronAuthorized('Bearer ', '')).toBe(false);
  });

  it('property: true iff the header is exactly Bearer + secret', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.string(), (secret, header) => {
        expect(cronAuthorized(header, secret)).toBe(header === `Bearer ${secret}`);
        expect(cronAuthorized(`Bearer ${secret}`, secret)).toBe(true);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('reporting', () => {
  it('uses the Eastern business date', () => {
    expect(businessDate(new Date('2026-10-21T03:30:00Z'))).toBe('Oct 20, 2026'); // 11:30 PM EDT
    expect(businessDate(NOW)).toBe('Oct 21, 2026');
  });

  it('writes an escaped failure notice', () => {
    const one = nightlyFailureEmail(NOW, ['Calibration: <boom> & "bust"']);
    expect(one.subject).toBe('Nightly learning run had a problem (Oct 21, 2026)');
    expect(one.text).toContain('- Calibration: <boom> & "bust"');
    expect(one.text).toContain('Pricing is unaffected');
    expect(one.html).toContain('<li>Calibration: &lt;boom&gt; &amp; &quot;bust&quot;</li>');
    expect(nightlyFailureEmail(NOW, ['a', 'b']).subject).toBe('Nightly learning run had 2 problems (Oct 21, 2026)');
  });

  it('summaryHasFailures looks at every step', () => {
    const ok: NightlySummary = {
      startedAt: '',
      finishedAt: '',
      trigger: 'cron',
      expiredQuotes: 0,
      calibration: { ...stubCalibration(), status: 'succeeded' },
      winModel: { runId: null, status: 'skipped', nQuotes: 0, trained: false, reason: '', buckets: null, error: null },
      deviationOutcomesUpdated: 0,
    };
    expect(summaryHasFailures(ok)).toBe(false);
    expect(summaryHasFailures({ ...ok, expiredQuotes: null })).toBe(true);
    expect(summaryHasFailures({ ...ok, deviationOutcomesUpdated: null })).toBe(true);
    expect(summaryHasFailures({ ...ok, calibration: { ...ok.calibration, status: 'failed' } })).toBe(true);
    expect(summaryHasFailures({ ...ok, winModel: { ...ok.winModel, status: 'failed' } })).toBe(true);
  });
});

function stubCalibration(): NightlySummary['calibration'] {
  return {
    runId: null,
    status: 'skipped',
    jobsConsidered: 0,
    jobsUsed: 0,
    candidateSetId: null,
    changedCount: 0,
    promoted: false,
    gates: [],
    holdout: null,
    accuracy: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// The nightly run
// ---------------------------------------------------------------------------

describe('runNightlyWith — end to end with the real math', () => {
  it('calibrates a good history into a promoted candidate and trains the win model', async () => {
    const h = harness({ loadJobsForLearning: async () => goodHistory(), loadDecidedQuotes: async () => decidedQuotes() });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });

    expect(s.startedAt).toBe(NOW.toISOString());
    expect(s.finishedAt).toBe('2026-10-21T07:16:30.000Z');
    expect(s.trigger).toBe('cron');
    expect(s.expiredQuotes).toBe(2);
    expect(s.deviationOutcomesUpdated).toBe(4);

    const c = s.calibration;
    expect(c).toMatchObject({ runId: 'run-1', status: 'succeeded', jobsConsidered: 30, jobsUsed: 30, candidateSetId: 'set-new', promoted: true, error: null });
    expect(c.changedCount).toBeGreaterThan(0);
    expect(c.gates.every((g) => g.passed)).toBe(true);
    expect(c.holdout?.n).toBeGreaterThan(0);
    expect(c.accuracy?.n).toBe(30);
    expect(h.insertCandidateSet).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-1', parentSetId: 'set-active' }));
    expect(h.promoteSet).toHaveBeenCalledWith('set-new', expect.stringMatching(/^Nightly calibration Oct 21, 2026: \d+ changed/));
    expect(h.rejectSet).not.toHaveBeenCalled();

    const calRun = finishOf(h, 'calibration')!;
    expect(calRun).toMatchObject({ status: 'succeeded', jobsConsidered: 30, jobsUsed: 30, candidateSetId: 'set-new', promoted: true, error: null });
    expect(calRun.summary).toMatchObject({ trigger: 'cron', outcome: 'promoted', changedCount: c.changedCount, nObservations: 30, autoPromotable: true });
    expect(calRun.summary).toHaveProperty('gates', c.gates);
    expect(calRun.summary).toHaveProperty('accuracy', c.accuracy);
    expect(calRun.summary).not.toHaveProperty('actorId');

    const w = s.winModel;
    expect(w).toMatchObject({ runId: 'run-2', status: 'succeeded', nQuotes: 60, trained: true, error: null });
    expect(w.buckets?.byMarkup.reduce((n, b) => n + b.quotes, 0)).toBe(60);
    expect(h.insertWinModel).toHaveBeenCalledWith('run-2', expect.objectContaining({ nQuotes: 60 }));
    const winRun = finishOf(h, 'win_model')!;
    expect(winRun).toMatchObject({ status: 'succeeded', jobsConsidered: 60, jobsUsed: 60, promoted: false, candidateSetId: null });
    expect(winRun.summary).toMatchObject({ trained: true, modelId: 'model-new', nQuotes: 60, buckets: w.buckets });

    expect(h.emails).toEqual([]);
    expect(summaryHasFailures(s)).toBe(false);
  });

  it('a corrupted actuals batch is stored as a candidate and rejected by the backtest, never promoted', async () => {
    const h = harness({ loadJobsForLearning: async () => corruptedHistory() });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'succeeded', candidateSetId: 'set-new', promoted: false });
    expect(s.calibration.gates.find((g) => g.name === 'backtest')?.passed).toBe(false);
    expect(h.rejectSet).toHaveBeenCalledWith('set-new', expect.stringMatching(/^Failed gate\(s\): backtest: Candidate is worse/));
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(finishOf(h, 'calibration')!.summary).toMatchObject({ outcome: 'rejected' });
  });

  it('holds a passing candidate for approval when auto-promote is off', async () => {
    const h = harness({ loadJobsForLearning: async () => goodHistory() }, { autoPromote: false });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'succeeded', candidateSetId: 'set-new', promoted: false });
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(finishOf(h, 'calibration')!.summary).toMatchObject({
      outcome: 'awaiting_approval',
      message: 'Every gate passed; awaiting owner approval (auto-promote is off).',
    });
  });

  it('with no completed jobs nothing changes and no candidate is created; the win model stays cold', async () => {
    const h = harness({ loadDecidedQuotes: async () => decidedQuotes().slice(0, 5) });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'succeeded', changedCount: 0, candidateSetId: null, jobsConsidered: 0, jobsUsed: 0 });
    expect(h.insertCandidateSet).not.toHaveBeenCalled();
    expect(finishOf(h, 'calibration')!.summary).toMatchObject({ outcome: 'no_change' });
    expect(s.winModel).toMatchObject({ status: 'succeeded', trained: false, nQuotes: 5 });
    expect(s.winModel.reason).toMatch(/needs at least 40/);
    expect(s.winModel.buckets?.bySource.map((b) => b.label).sort()).toEqual(['Referral', 'Website']);
    expect(h.insertWinModel).not.toHaveBeenCalled();
  });

  it('counts only jobs that produced an observation as used, and skips undecidable quotes', async () => {
    const unusable: JobForLearning = { ...syntheticJob(1), jobId: 'job-unusable', snapshot: { options: [] }, actuals: [] };
    const broken: QuoteOutcomeRow = { ...quoteRow(99, true, 1.5), snapshot: {} };
    const h = harness({
      loadJobsForLearning: async () => [...goodHistory(), unusable],
      loadDecidedQuotes: async () => [...decidedQuotes(), broken],
    });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ jobsConsidered: 31, jobsUsed: 30 });
    expect(s.winModel.nQuotes).toBe(60);
    expect(finishOf(h, 'win_model')).toMatchObject({ jobsConsidered: 61, jobsUsed: 60 });
  });
});

describe('runNightlyWith — candidate decisions', () => {
  const run = async (result: CalibrationResult, over: Partial<NightlyDeps> = {}, settings: Partial<LearningSettings> = {}) => {
    const h = harness({ calibrate: () => result, ...over }, settings);
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    return { h, s, run: finishOf(h, 'calibration')! };
  };

  it('does not store a candidate that fails the sanity gate', async () => {
    const { h, s, run: r } = await run(stubResult({ gates: allGates(['sanity']), passed: false, autoPromotable: false }));
    expect(h.insertCandidateSet).not.toHaveBeenCalled();
    expect(s.calibration).toMatchObject({ status: 'succeeded', candidateSetId: null, promoted: false });
    expect(r.summary).toMatchObject({ outcome: 'not_stored', message: 'Candidate not stored: sanity detail' });
  });

  it('rejects a stored candidate that fails another gate', async () => {
    const { h, run: r } = await run(stubResult({ gates: allGates(['backtest', 'bounds']), passed: false, autoPromotable: false }));
    expect(h.rejectSet).toHaveBeenCalledWith('set-new', 'Failed gate(s): bounds: bounds detail backtest: backtest detail');
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(r.summary).toMatchObject({ outcome: 'rejected' });
  });

  it('waits for approval when the backtest had too little data, even with auto-promote on', async () => {
    const { h, run: r } = await run(stubResult({ autoPromotable: false }));
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(r.summary.message).toMatch(/too little recent data/);
  });

  it('never promotes over an active set that changed during the run', async () => {
    const { h, s, run: r } = await run(stubResult(), { loadActiveSetId: async () => 'set-rolled-back' });
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(s.calibration.promoted).toBe(false);
    expect(r.summary).toMatchObject({ outcome: 'awaiting_approval' });
    expect(r.summary.message).toMatch(/active set changed/);
  });

  it('a failing promotion leaves the candidate for approval and fails the step', async () => {
    const { s, h, run: r } = await run(stubResult(), {
      promoteSet: async () => {
        throw new Error('set x is not a candidate');
      },
    });
    expect(s.calibration).toMatchObject({ status: 'failed', candidateSetId: 'set-new', promoted: false, error: 'set x is not a candidate' });
    expect(r).toMatchObject({ status: 'failed', promoted: false, error: 'set x is not a candidate' });
    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.text).toContain('- Calibration: set x is not a candidate');
  });
});

describe('runNightlyWith — failure isolation', () => {
  const boom = (msg: string) => async (): Promise<never> => {
    throw new Error(msg);
  };

  it('a failure in each step is recorded, later steps still run, and the owner gets one email', async () => {
    const h = harness({
      expireStaleQuotes: boom('rpc down'),
      loadJobsForLearning: boom('jobs timeout'),
      loadDecidedQuotes: async () => decidedQuotes(),
      insertWinModel: vi.fn<NightlyDeps['insertWinModel']>(boom('unique violation')),
      updateDeviationOutcomes: boom('flags timeout'),
    });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });

    expect(s.expiredQuotes).toBeNull();
    expect(s.calibration).toMatchObject({ runId: 'run-1', status: 'failed', error: 'jobs timeout', candidateSetId: null, promoted: false });
    expect(finishOf(h, 'calibration')).toMatchObject({ status: 'failed', error: 'jobs timeout', promoted: false });
    expect(s.winModel).toMatchObject({ runId: 'run-2', status: 'failed', error: 'unique violation', trained: false });
    expect(s.winModel.buckets).not.toBeNull(); // computed before the failing write
    expect(finishOf(h, 'win_model')).toMatchObject({ status: 'failed', error: 'unique violation' });
    expect(s.deviationOutcomesUpdated).toBeNull();
    expect(h.promoteSet).not.toHaveBeenCalled();
    expect(summaryHasFailures(s)).toBe(true);

    expect(h.emails).toHaveLength(1);
    expect(h.emails[0]!.to).toBe('owner@example.com');
    expect(h.emails[0]!.subject).toBe('Nightly learning run had 4 problems (Oct 21, 2026)');
    expect(h.emails[0]!.text).toContain('- Expiring stale quotes: rpc down');
    expect(h.emails[0]!.text).toContain('- Calibration: jobs timeout');
    expect(h.emails[0]!.text).toContain('- Win model: unique violation');
    expect(h.emails[0]!.text).toContain('- Scoring deviation flags: flags timeout');
    expect(h.logs).toContain('[nightly] Calibration failed: jobs timeout');
  });

  it('without settings the learning steps fail without touching the database; housekeeping still runs', async () => {
    const h = harness({ loadSettings: boom('settings unreadable') });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(h.started).toEqual([]);
    expect(s.calibration).toMatchObject({ runId: null, status: 'failed', error: 'Learning settings could not be loaded.' });
    expect(s.winModel).toMatchObject({ runId: null, status: 'failed', reason: 'Learning settings could not be loaded.' });
    expect(s.expiredQuotes).toBe(2);
    expect(s.deviationOutcomesUpdated).toBe(4);
    expect(h.emails[0]!.text).toContain('- Loading learning settings: settings unreadable');
  });

  it('skips a step while another run of the same kind is in progress', async () => {
    const h = harness({ startRun: async () => null });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'skipped', runId: null, error: 'Another calibration run is still in progress.' });
    expect(s.winModel).toMatchObject({ status: 'skipped', reason: 'Another win-model run is still in progress.' });
    expect(h.finished).toEqual([]);
    expect(h.emails).toEqual([]);
    expect(summaryHasFailures(s)).toBe(false);
  });

  it('a run row that cannot be opened fails the step without a run id', async () => {
    const h = harness({ startRun: boom('insert denied') });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'failed', runId: null, error: 'insert denied' });
    expect(s.winModel).toMatchObject({ status: 'failed', runId: null, error: 'insert denied', reason: 'The win-model run failed.' });
    expect(h.finished).toEqual([]);
  });

  it('a run row that cannot be closed turns a success into a failure', async () => {
    const h = harness({ finishRun: boom('update denied') });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration).toMatchObject({ status: 'failed', error: 'Recording the run failed: update denied' });
    expect(s.winModel).toMatchObject({ status: 'failed', error: 'Recording the run failed: update denied' });
    expect(h.emails[0]!.text).toContain('- Recording the calibration run: update denied');
    expect(h.emails[0]!.text).toContain('- Recording the win-model run: update denied');
  });

  it('keeps the original error when closing a failed run also fails', async () => {
    const h = harness({ loadActiveCoefficients: boom('no active set'), finishRun: boom('update denied') });
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(s.calibration.error).toBe('no active set');
  });

  it('never throws because of email, and does not email without an owner address', async () => {
    const failing = harness({ expireStaleQuotes: boom('x'), sendEmail: boom('smtp down') });
    await expect(runNightlyWith(failing.deps, NOW, { trigger: 'cron' })).resolves.toMatchObject({ expiredQuotes: null });
    expect(failing.logs).toContain('[nightly] emailing the owner failed: smtp down');

    const silent = harness({ expireStaleQuotes: boom('x'), ownerEmail: null });
    await runNightlyWith(silent.deps, NOW, { trigger: 'cron' });
    expect(silent.emails).toEqual([]);
  });

  it('works without a logger and with non-Error throws', async () => {
    const h = harness({
      log: undefined,
      expireStaleQuotes: async () => {
        throw 'plain string';
      },
    });
    await runNightlyWith(h.deps, NOW, { trigger: 'cron' });
    expect(h.emails[0]!.text).toContain('- Expiring stale quotes: plain string');
  });

  it('rejects an invalid clock before touching anything', async () => {
    const h = harness();
    await expect(runNightlyWith(h.deps, new Date('nope'), { trigger: 'cron' })).rejects.toThrow(RangeError);
    expect(h.started).toEqual([]);
  });
});

describe('runNightlyWith — manual runs', () => {
  it('records the trigger and the owner who started it on both runs', async () => {
    const h = harness();
    const s = await runNightlyWith(h.deps, NOW, { trigger: 'manual', actorId: 'owner-1' });
    expect(s.trigger).toBe('manual');
    expect(h.started.map((r) => r.summary)).toEqual([
      { trigger: 'manual', actorId: 'owner-1' },
      { trigger: 'manual', actorId: 'owner-1' },
    ]);
    expect(finishOf(h, 'calibration')!.summary).toMatchObject({ trigger: 'manual', actorId: 'owner-1' });
    expect(finishOf(h, 'win_model')!.summary).toMatchObject({ trigger: 'manual', actorId: 'owner-1' });

    const anonymous = harness();
    await runNightlyWith(anonymous.deps, NOW, { trigger: 'manual' });
    expect(anonymous.started[0]!.summary).toEqual({ trigger: 'manual', actorId: null });
  });
});
