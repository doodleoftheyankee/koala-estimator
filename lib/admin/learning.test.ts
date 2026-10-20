import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, COEFF_KINDS, JOB_TYPES, PRODUCTS } from '@/lib/pricing';
import type { NightlySummary } from '@/lib/learning/nightly';
import {
  accuracySentences,
  approveForm,
  backtestRows,
  canRestore,
  candidateNotes,
  candidateSetRowSchema,
  coefficientChangeRowSchema,
  coefficientRowSchema,
  coefficientSetRowSchema,
  compareScopes,
  confidencePct,
  decisionForm,
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
  isStepLimitedNote,
  jobTypeLabel,
  KIND_HELP,
  KIND_LABELS,
  learningRunRowSchema,
  nightlyHasFailures,
  nightlyResultMessage,
  noticeMessage,
  noticeQuery,
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
  runKindLabel,
  scopeKey,
  scopeLabel,
  scopeNamesFrom,
  setSourceLabel,
  sparkline,
  winColdStartMessage,
  winModelRowSchema,
  type DashboardCoefficient,
} from './learning';

const ID = '8f14e45f-ceea-467f-a8f6-3b3a0c6c2b10';

function coef(over: Partial<DashboardCoefficient> = {}): DashboardCoefficient {
  return {
    kind: 'waste_factor',
    product: 'cellulose',
    jobType: null,
    accessLevel: null,
    value: 1.08,
    priorValue: 1.08,
    lowerBound: 1,
    upperBound: 1.6,
    stdError: null,
    sampleSize: 0,
    nEff: 0,
    confidence: 0,
    wasClamped: false,
    wasStepLimited: false,
    ...over,
  };
}

const NAMES = scopeNamesFrom({
  products: [
    { code: 'cellulose', label: 'Blown Cellulose' },
    { code: 'ocsf', label: 'Open-Cell Spray Foam' },
    { code: 'bogus', label: 'Ignored' },
  ],
  jobTypes: [
    { code: 'attic', label: 'Attic' },
    { code: 'rim_joist', label: 'Basement Rim Joist' },
  ],
  accessLevels: [
    { code: 'difficult', label: 'Difficult' },
    { code: 'easy', label: '  ' },
  ],
});

// ---------------------------------------------------------------------------
// Kinds and scopes
// ---------------------------------------------------------------------------

describe('kind labels', () => {
  it('names and explains every kind in plain English', () => {
    for (const k of COEFF_KINDS) {
      expect(KIND_LABELS[k]).toMatch(/^[A-Z][a-z ]+/);
      expect(KIND_HELP[k].length).toBeGreaterThan(10);
    }
    expect(KIND_LABELS.labor_hrs_per_unit).toBe('Labor hours per unit');
    expect(KIND_LABELS.removal_hrs_per_sqft).toBe('Removal hours per sq ft');
  });
});

describe('scopeNamesFrom', () => {
  it('keeps known codes with non-blank labels only', () => {
    expect(NAMES.products).toEqual({ cellulose: 'Blown Cellulose', ocsf: 'Open-Cell Spray Foam' });
    expect(NAMES.accessLevels).toEqual({ difficult: 'Difficult' });
    expect(scopeNamesFrom({})).toEqual({ products: {}, jobTypes: {}, accessLevels: {} });
  });
});

describe('scopeLabel', () => {
  it('reads like the owner talks', () => {
    expect(scopeLabel({ product: 'cellulose', jobType: 'attic', accessLevel: null }, NAMES)).toBe('Blown cellulose · attic');
    expect(scopeLabel({ product: 'ocsf', jobType: 'rim_joist', accessLevel: null }, NAMES)).toBe('Open-cell spray foam · basement rim joist');
    expect(scopeLabel({ product: null, jobType: null, accessLevel: 'difficult' }, NAMES)).toBe('Difficult access');
    expect(scopeLabel({ product: null, jobType: 'attic', accessLevel: null }, NAMES)).toBe('Attic');
    expect(scopeLabel({ product: null, jobType: null, accessLevel: null }, NAMES)).toBe('All jobs');
  });
  it('labels stored job-type codes, leaving unknown ones as they are', () => {
    expect(jobTypeLabel('rim_joist', NAMES)).toBe('Basement rim joist');
    expect(jobTypeLabel('walls')).toBe('Walls');
    expect(jobTypeLabel('Unknown')).toBe('Unknown');
  });
  it('falls back to the code when no name is known', () => {
    expect(scopeLabel({ product: 'fiberglass_blown', jobType: 'rim_joist', accessLevel: 'easy' })).toBe('Fiberglass blown · rim joist · easy access');
    expect(scopeLabel({ product: null, jobType: 'crawlspace', accessLevel: null }, NAMES)).toBe('Crawlspace');
  });
});

describe('scopeKey and compareScopes', () => {
  it('keys by kind and all three scope fields', () => {
    expect(scopeKey(coef())).toBe('waste_factor|cellulose|*|*');
    expect(scopeKey(coef({ jobType: 'attic', accessLevel: 'easy' }))).toBe('waste_factor|cellulose|attic|easy');
  });
  it('orders by kind, then product, job type and access, unscoped first', () => {
    const rows = [
      coef({ kind: 'access_mult', product: null, accessLevel: 'extreme' }),
      coef({ jobType: 'attic' }),
      coef({ product: 'ocsf' }),
      coef(),
      coef({ kind: 'access_mult', product: null, accessLevel: 'easy' }),
    ];
    expect([...rows].sort(compareScopes).map(scopeKey)).toEqual([
      'waste_factor|ocsf|*|*',
      'waste_factor|cellulose|*|*',
      'waste_factor|cellulose|attic|*',
      'access_mult|*|*|easy',
      'access_mult|*|*|extreme',
    ]);
  });
});

describe('groupByKind', () => {
  it('groups in engine kind order and skips empty kinds', () => {
    const groups = groupByKind([
      coef({ kind: 'drive_time_factor', product: null }),
      coef({ jobType: 'attic' }),
      coef(),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(['waste_factor', 'drive_time_factor']);
    expect(groups[0]!.rows.map((r) => r.jobType)).toEqual([null, 'attic']);
    expect(groups[0]!.label).toBe('Waste factor');
    expect(groupByKind([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

describe('row schemas', () => {
  it('parses coefficient rows with numeric strings into camelCase', () => {
    const row = coefficientRowSchema.parse({
      kind: 'labor_hrs_per_unit',
      product: 'cellulose',
      job_type: 'attic',
      access_level: null,
      value: '0.150000',
      prior_value: 0.15,
      lower_bound: '0.02',
      upper_bound: '1.0',
      std_error: null,
      sample_size: 12,
      n_eff: '9.40',
      confidence: '61.25',
      was_clamped: false,
    });
    expect(row).toMatchObject({ kind: 'labor_hrs_per_unit', jobType: 'attic', value: 0.15, nEff: 9.4, confidence: 61.25, stdError: null });
    expect(() => coefficientRowSchema.parse({ ...row, kind: 'nope' })).toThrow();
  });

  it('rejects blank or non-numeric numeric columns', () => {
    const base = {
      kind: 'waste_factor',
      product: null,
      job_type: null,
      access_level: null,
      value: '',
      prior_value: 1,
      lower_bound: 1,
      upper_bound: 2,
      std_error: null,
      sample_size: 0,
      n_eff: 0,
      confidence: 0,
      was_clamped: false,
    };
    expect(coefficientRowSchema.safeParse(base).success).toBe(false);
    expect(coefficientRowSchema.safeParse({ ...base, value: 'abc' }).success).toBe(false);
  });

  it('parses sets, runs, changes, win models and profiles', () => {
    const set = {
      id: ID,
      version: '3',
      status: 'candidate',
      source: 'nightly',
      parent_id: null,
      notes: null,
      created_at: '2026-10-20T07:15:00Z',
      created_by: null,
      activated_at: null,
      activated_by: null,
    };
    expect(coefficientSetRowSchema.parse(set).version).toBe(3);
    expect(coefficientSetRowSchema.safeParse({ ...set, status: 'archived' }).success).toBe(false);
    expect(candidateSetRowSchema.parse({ ...set, learning_run_id: null, metrics: { holdout: null }, gate_results: {} })).toMatchObject({
      version: 3,
      metrics: { holdout: null },
    });
    expect(candidateSetRowSchema.safeParse(set).success).toBe(false);
    expect(
      learningRunRowSchema.parse({
        id: ID,
        kind: 'calibration',
        started_at: 'x',
        finished_at: null,
        status: 'running',
        jobs_considered: null,
        jobs_used: '4',
        candidate_set_id: null,
        promoted: false,
        summary: {},
        error: null,
      }).jobs_used,
    ).toBe(4);
    expect(
      coefficientChangeRowSchema.parse({
        id: '17',
        at: '2026-10-20T07:15:00Z',
        from_set_id: null,
        to_set_id: ID,
        kind: 'access_mult',
        product: null,
        job_type: null,
        access_level: 'difficult',
        old_value: '1.35',
        new_value: '1.4',
        pct_change: '0.037',
        reason: 'nightly',
        actor_id: null,
      }),
    ).toMatchObject({ id: 17, accessLevel: 'difficult', oldValue: 1.35, newValue: 1.4, pctChange: 0.037, toSetId: ID });
    expect(winModelRowSchema.parse({ id: ID, trained_at: 'x', n_quotes: '41', metrics: null, learning_run_id: null }).n_quotes).toBe(41);
    expect(profileNameRowSchema.parse({ id: ID, full_name: 'Pat' })).toEqual({ id: ID, full_name: 'Pat' });
  });

  it('parseRows names the table and row on a bad row', () => {
    expect(parseRows(profileNameRowSchema, null, 'profile')).toEqual([]);
    expect(parseRows(profileNameRowSchema, undefined, 'profile')).toEqual([]);
    expect(() => parseRows(profileNameRowSchema, {}, 'profile')).toThrow('Unexpected profile data: not a list');
    expect(() => parseRows(profileNameRowSchema, [{ id: ID, full_name: 'A' }, { id: ID }], 'profile')).toThrow(
      /Unexpected profile row #2 \(full_name\)/,
    );
    expect(() => parseRows(profileNameRowSchema, ['x'], 'profile')).toThrow(/Unexpected profile row #1: /);
  });

  it('parseRow handles a missing single row', () => {
    expect(parseRow(profileNameRowSchema, null, 'profile')).toBeNull();
    expect(parseRow(profileNameRowSchema, { id: ID, full_name: 'B' }, 'profile')).toEqual({ id: ID, full_name: 'B' });
  });
});

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

describe('pctChange', () => {
  it('is relative to the old value and null when undefined', () => {
    expect(pctChange(1, 1.1)).toBeCloseTo(0.1);
    expect(pctChange(2, 1.5)).toBeCloseTo(-0.25);
    expect(pctChange(0, 1)).toBeNull();
    expect(pctChange(null, 1)).toBeNull();
    expect(pctChange(1, undefined)).toBeNull();
    expect(pctChange(Number.NaN, 1)).toBeNull();
    expect(pctChange(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
  it('has the sign of the change (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1e-6, max: 1e6, noNaN: true }), fc.double({ min: 1e-6, max: 1e6, noNaN: true }), (a, b) => {
        const p = pctChange(a, b)!;
        expect(Number.isFinite(p)).toBe(true);
        expect(Math.sign(p)).toBe(Math.sign(b - a));
        expect(a * (1 + p)).toBeCloseTo(b, 6);
      }),
    );
  });
});

describe('candidateNotes and isStepLimitedNote', () => {
  it('keys notes by scope and skips malformed entries', () => {
    const notes = candidateNotes({
      notes: [
        { kind: 'waste_factor', product: 'cellulose', jobType: 'attic', accessLevel: null, note: 'n_eff 14.2, raw 1.17, step-limited to 1.12' },
        { kind: 'access_mult', accessLevel: 'easy', note: 'missing keys are wildcards' },
        { kind: 'waste_factor', product: 'unobtainium', note: 'bad product' },
        { kind: 'bogus', note: 'x' },
        'nope',
      ],
    });
    expect([...notes.keys()]).toEqual(['waste_factor|cellulose|attic|*', 'access_mult|*|*|easy']);
    expect(candidateNotes(null).size).toBe(0);
    expect(candidateNotes({ notes: 'x' }).size).toBe(0);
    expect(candidateNotes([]).size).toBe(0);
  });
  it('detects step limiting from the calibration note', () => {
    expect(isStepLimitedNote('n_eff 9, raw 1.3, shrunk 1.25, step-limited to 1.19')).toBe(true);
    expect(isStepLimitedNote('n_eff 9, step-limited, clamped to 1.6')).toBe(true);
    expect(isStepLimitedNote('n_eff 9, raw 1.1, shrunk 1.1')).toBe(false);
    expect(isStepLimitedNote(null)).toBe(false);
  });
});

describe('diffCoefficients', () => {
  const active = [
    coef(),
    coef({ kind: 'access_mult', product: null, accessLevel: 'difficult', value: 1.35, priorValue: 1.35 }),
    coef({ kind: 'drive_time_factor', product: null, value: 1.1, priorValue: 1.1 }),
  ];

  it('lists changed, new and removed cells only, with notes and badges', () => {
    const candidate = [
      coef({ value: 1.12, sampleSize: 20, nEff: 14.2, confidence: 78, stdError: 0.01 }),
      coef({ jobType: 'attic', value: 1.15, sampleSize: 9, nEff: 6.1, confidence: 40, wasClamped: true }),
      coef({ kind: 'access_mult', product: null, accessLevel: 'difficult', value: 1.35, priorValue: 1.35 }),
    ];
    const notes = candidateNotes({
      notes: [
        { kind: 'waste_factor', product: 'cellulose', jobType: null, accessLevel: null, note: 'n_eff 14.2, step-limited to 1.12' },
        { kind: 'waste_factor', product: 'cellulose', jobType: 'attic', accessLevel: null, note: 'new cell (was 1.08), clamped to 1.15' },
        { kind: 'drive_time_factor', product: null, jobType: null, accessLevel: null, note: 'dropped' },
      ],
    });
    const diff = diffCoefficients(candidate, active, notes);
    expect(diff.map((d) => [d.key, d.change])).toEqual([
      ['waste_factor|cellulose|*|*', 'changed'],
      ['waste_factor|cellulose|attic|*', 'new'],
      ['drive_time_factor|*|*|*', 'removed'],
    ]);
    const [changed, added, removed] = diff;
    expect(changed).toMatchObject({ oldValue: 1.08, baseValue: 1.08, newValue: 1.12, wasStepLimited: true, wasClamped: false, nEff: 14.2, stdError: 0.01 });
    expect(changed!.pctChange).toBeCloseTo(0.04 / 1.08);
    // A new job-type cell inherits its product-level parent as the value pricing used until now.
    expect(added).toMatchObject({ oldValue: null, baseValue: 1.08, newValue: 1.15, wasClamped: true, wasStepLimited: false });
    expect(added!.note).toMatch(/new cell/);
    expect(removed).toMatchObject({ oldValue: 1.1, newValue: null, pctChange: null, sampleSize: null, note: 'dropped' });
  });

  it('a new cell with no parent has no base value', () => {
    const diff = diffCoefficients([coef({ kind: 'photo_area_bias', product: null, jobType: 'attic', value: 0.95 })], []);
    expect(diff[0]).toMatchObject({ change: 'new', baseValue: null, pctChange: null, note: null });
  });

  it('is empty for identical sets and ignores float noise', () => {
    expect(diffCoefficients(active, active)).toEqual([]);
    expect(diffCoefficients(active.map((c) => ({ ...c, value: c.value + 1e-12 })), active)).toEqual([]);
    expect(diffCoefficients([], [])).toEqual([]);
  });

  it('applying the diff to the active set yields the candidate (property)', () => {
    const scope = fc.record({
      kind: fc.constantFrom(...COEFF_KINDS),
      product: fc.option(fc.constantFrom(...PRODUCTS), { nil: null }),
      jobType: fc.option(fc.constantFrom(...JOB_TYPES), { nil: null }),
      accessLevel: fc.option(fc.constantFrom(...ACCESS_LEVELS), { nil: null }),
    });
    const set = fc
      .array(fc.tuple(scope, fc.double({ min: 0.01, max: 10, noNaN: true })), { maxLength: 25 })
      .map((xs) => {
        const byKey = new Map<string, DashboardCoefficient>();
        for (const [s, v] of xs) byKey.set(scopeKey(s), coef({ ...s, value: v }));
        return [...byKey.values()];
      });
    fc.assert(
      fc.property(set, set, (candidate, activeSet) => {
        const diff = diffCoefficients(candidate, activeSet);
        const applied = new Map(activeSet.map((c) => [scopeKey(c), c.value]));
        for (const d of diff) {
          if (d.change === 'removed') applied.delete(d.key);
          else applied.set(d.key, d.newValue!);
          expect(d.change === 'new').toBe(d.oldValue === null);
        }
        // Values within float noise of the active one count as unchanged.
        expect([...applied.keys()].sort()).toEqual(candidate.map(scopeKey).sort());
        for (const c of candidate) expect(Math.abs(applied.get(scopeKey(c))! - c.value)).toBeLessThanOrEqual(1e-9);
        // Sorted and unique.
        expect(new Set(diff.map((d) => d.key)).size).toBe(diff.length);
        for (let i = 1; i < diff.length; i++) expect(compareScopes(diff[i - 1]!, diff[i]!)).toBeLessThanOrEqual(0);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// jsonb parsing
// ---------------------------------------------------------------------------

describe('parseGates', () => {
  it('reads gate_results.gates or a bare list, skipping junk', () => {
    const gates = parseGates({
      gates: [
        { name: 'backtest', passed: false, detail: 'Candidate is worse on hours.' },
        { name: 'min_evidence', passed: true },
        { name: 'future_gate', passed: true, detail: 'x' },
        { name: 'bounds' },
        null,
      ],
    });
    expect(gates).toEqual([
      { name: 'backtest', label: 'Backtest', passed: false, detail: 'Candidate is worse on hours.' },
      { name: 'min_evidence', label: 'Minimum evidence', passed: true, detail: '' },
      { name: 'future_gate', label: 'Future gate', passed: true, detail: 'x' },
    ]);
    expect(parseGates([{ name: 'sanity', passed: true, detail: 'ok' }])[0]!.label).toBe('Sanity check');
    expect(parseGates({})).toEqual([]);
    expect(parseGates(null)).toEqual([]);
  });
});

describe('parseHoldout and backtestRows', () => {
  it('reads metrics.holdout leniently', () => {
    expect(parseHoldout({ holdout: { n: '12', hoursMapeActive: 0.2, hoursMapeCandidate: '0.15', qtyMapeActive: null } })).toEqual({
      n: 12,
      hoursMapeActive: 0.2,
      hoursMapeCandidate: 0.15,
      qtyMapeActive: null,
      qtyMapeCandidate: null,
    });
    expect(parseHoldout({ holdout: null })).toBeNull();
    expect(parseHoldout({ holdout: { hoursMapeActive: 0.2 } })).toBeNull();
    expect(parseHoldout('x')).toBeNull();
  });
  it('compares active vs candidate error (lower is better)', () => {
    const rows = backtestRows({ n: 10, hoursMapeActive: 0.2, hoursMapeCandidate: 0.15, qtyMapeActive: 0.1, qtyMapeCandidate: 0.12 });
    expect(rows.map((r) => [r.metric, r.verdict])).toEqual([
      ['hours', 'better'],
      ['qty', 'worse'],
    ]);
    expect(backtestRows({ n: 1, hoursMapeActive: 0.1, hoursMapeCandidate: 0.1, qtyMapeActive: null, qtyMapeCandidate: 0.1 }).map((r) => r.verdict)).toEqual([
      'same',
      null,
    ]);
  });
});

describe('accuracy', () => {
  const report = { n: 14, hoursMapeModel: 0.123, hoursMapeEstimator: 0.152, qtyMapeModel: 0.081, qtyMapeEstimator: null };

  it('parses summary.accuracy', () => {
    expect(parseAccuracy({ accuracy: report })).toEqual(report);
    expect(parseAccuracy({ accuracy: { ...report, n: 'x' } })).toBeNull();
    expect(parseAccuracy({ accuracy: null })).toBeNull();
    expect(parseAccuracy(null)).toBeNull();
  });

  it('hasAccuracy needs observations and at least one figure', () => {
    expect(hasAccuracy(report)).toBe(true);
    expect(hasAccuracy({ n: 0, hoursMapeModel: null, hoursMapeEstimator: null, qtyMapeModel: null, qtyMapeEstimator: null })).toBe(false);
    expect(hasAccuracy({ n: 3, hoursMapeModel: null, hoursMapeEstimator: null, qtyMapeModel: null, qtyMapeEstimator: null })).toBe(false);
    expect(hasAccuracy(null)).toBe(false);
  });

  it('explains MAPE in plain words', () => {
    expect(accuracySentences(report)).toEqual([
      "On average the model was off by 12% on labor hours; estimators' own numbers were off by 15%.",
      'On average the model was off by 8.1% on material quantities.',
    ]);
    expect(accuracySentences({ n: 2, hoursMapeModel: null, hoursMapeEstimator: 0.3, qtyMapeModel: null, qtyMapeEstimator: null })).toEqual([
      "On average estimators' numbers were off by 30% on labor hours.",
    ]);
    expect(accuracySentences({ n: 0, hoursMapeModel: null, hoursMapeEstimator: null, qtyMapeModel: null, qtyMapeEstimator: null })).toEqual([]);
  });
});

describe('parseRunMeta and labels', () => {
  it('reads trigger, actor and outcome', () => {
    expect(parseRunMeta({ trigger: 'manual', actorId: ID, outcome: 'awaiting_approval', message: 'Every gate passed.' })).toEqual({
      trigger: 'manual',
      actorId: ID,
      outcome: 'awaiting_approval',
      message: 'Every gate passed.',
    });
    expect(parseRunMeta({ trigger: 'other', actorId: '  ', outcome: 5 })).toEqual({ trigger: null, actorId: null, outcome: null, message: null });
    expect(parseRunMeta(null).trigger).toBeNull();
  });
  it('labels outcomes, run kinds and set sources', () => {
    expect(outcomeLabel('promoted')).toBe('Promoted automatically');
    expect(outcomeLabel('brand_new')).toBe('Brand new');
    expect(outcomeLabel(null)).toBeNull();
    expect(runKindLabel('win_model')).toBe('Win model');
    expect(runKindLabel('lead_model')).toBe('Lead model');
    expect(runKindLabel('mystery_run')).toBe('Mystery run');
    expect(setSourceLabel('rollback')).toBe('Restored copy');
    expect(setSourceLabel('import_job')).toBe('Import job');
  });
  it('spots runs that never finished', () => {
    const now = Date.parse('2026-10-20T08:00:00Z');
    const staleMs = 15 * 60_000;
    expect(isStalledRun({ status: 'running', started_at: '2026-10-20T07:15:00Z' }, now, staleMs)).toBe(true);
    expect(isStalledRun({ status: 'running', started_at: '2026-10-20T07:50:00Z' }, now, staleMs)).toBe(false);
    expect(isStalledRun({ status: 'failed', started_at: '2026-10-20T07:15:00Z' }, now, staleMs)).toBe(false);
    expect(isStalledRun({ status: 'running', started_at: 'garbage' }, now, staleMs)).toBe(false);
  });
  it('only superseded and rejected sets can be restored', () => {
    expect(canRestore('superseded')).toBe(true);
    expect(canRestore('rejected')).toBe(true);
    expect(canRestore('active')).toBe(false);
    expect(canRestore('candidate')).toBe(false);
  });
});

describe('win rate', () => {
  it('parses the win-model run summary and recomputes win rates', () => {
    const s = parseWinRunSummary({
      nQuotes: 12,
      decidedQuotes: '13',
      trained: false,
      reason: 'Only 12 decided quotes.',
      buckets: {
        byMarkup: [
          { label: '<1.4×', quotes: 4, wins: 3, winRate: 0.9 },
          { label: '2.0×+', quotes: 0, wins: 0, winRate: 0 },
          { label: 'bad', quotes: -1, wins: 0 },
          { quotes: 1, wins: 1 },
          'x',
        ],
        byJobType: [{ label: 'attic', quotes: '8', wins: '2' }],
        bySource: 'nope',
      },
    });
    expect(s).toEqual({
      nQuotes: 12,
      decidedQuotes: 13,
      trained: false,
      reason: 'Only 12 decided quotes.',
      buckets: {
        byMarkup: [
          { label: '<1.4×', quotes: 4, wins: 3, winRate: 0.75 },
          { label: '2.0×+', quotes: 0, wins: 0, winRate: 0 },
        ],
        byJobType: [{ label: 'attic', quotes: 8, wins: 2, winRate: 0.25 }],
        bySource: [],
      },
    });
    expect(parseWinRunSummary(null)).toEqual({ nQuotes: null, decidedQuotes: null, trained: false, reason: null, buckets: null });
    expect(parseWinRunSummary({ trained: true, reason: ' ' })).toMatchObject({ trained: true, reason: null });
  });

  it('parses model metrics', () => {
    expect(parseWinMetrics({ auc: 0.71, logLoss: '0.58', baseRate: 0.4 })).toEqual({ auc: 0.71, logLoss: 0.58, baseRate: 0.4 });
    expect(parseWinMetrics({ auc: null })).toEqual({ auc: null, logLoss: null, baseRate: null });
    expect(parseWinMetrics(undefined)).toEqual({ auc: null, logLoss: null, baseRate: null });
  });

  it('explains the cold start', () => {
    expect(winColdStartMessage(40, 12)).toBe('Price recommendations start after 40 decided quotes (you have 12).');
    expect(winColdStartMessage(1, 0)).toBe('Price recommendations start after 1 decided quote (you have 0).');
    expect(winColdStartMessage(40, null)).toBe('Price recommendations start after 40 decided quotes. The first nightly run will count yours.');
    expect(winColdStartMessage(40, 45, 'All 45 decided quotes were won.')).toBe(
      'You have 45 decided quotes, enough to train, but no price model is active yet: All 45 decided quotes were won.',
    );
    expect(winColdStartMessage(40, 40)).toMatch(/no price model is active yet\.$/);
  });
});

// ---------------------------------------------------------------------------
// Manual run result
// ---------------------------------------------------------------------------

function summary(over: { calibration?: Partial<NightlySummary['calibration']>; winModel?: Partial<NightlySummary['winModel']> } & Partial<Omit<NightlySummary, 'calibration' | 'winModel'>> = {}): NightlySummary {
  const { calibration, winModel, ...rest } = over;
  return {
    startedAt: '2026-10-20T19:00:00Z',
    finishedAt: '2026-10-20T19:00:05Z',
    trigger: 'manual',
    expiredQuotes: 0,
    deviationOutcomesUpdated: 0,
    ...rest,
    calibration: {
      runId: 'r1',
      status: 'succeeded',
      jobsConsidered: 10,
      jobsUsed: 8,
      candidateSetId: null,
      changedCount: 0,
      promoted: false,
      gates: [],
      holdout: null,
      accuracy: null,
      error: null,
      ...calibration,
    },
    winModel: {
      runId: 'r2',
      status: 'succeeded',
      nQuotes: 12,
      trained: false,
      reason: 'Only 12 decided quotes; the win model needs at least 40.',
      buckets: null,
      error: null,
      ...winModel,
    },
  };
}

describe('nightlyResultMessage', () => {
  it('summarizes a quiet run', () => {
    const r = nightlyResultMessage(summary());
    expect(r.ok).toBe(true);
    expect(r.message).toBe(
      'Learning run finished. Calibration: no coefficient moved (8 of 10 completed jobs usable). Win model not trained: Only 12 decided quotes; the win model needs at least 40.',
    );
  });

  it('covers every calibration outcome', () => {
    const changed = { changedCount: 3, candidateSetId: 's1' };
    expect(nightlyResultMessage(summary({ calibration: { ...changed, promoted: true } })).message).toMatch(/3 coefficients changed; every gate passed and the new set was promoted/);
    expect(nightlyResultMessage(summary({ calibration: changed })).message).toMatch(/the candidate is waiting for your approval\./);
    expect(
      nightlyResultMessage(summary({ calibration: { ...changed, gates: [{ name: 'backtest', passed: false, detail: 'worse' }] } })).message,
    ).toMatch(/candidate was rejected \(failed: Backtest\)/);
    expect(
      nightlyResultMessage(summary({ calibration: { changedCount: 1, gates: [{ name: 'sanity', passed: false, detail: 'bad' }] } })).message,
    ).toMatch(/1 coefficient changed, but the candidate was not stored \(Sanity check failed\)/);
    expect(nightlyResultMessage(summary({ calibration: { changedCount: 2 } })).message).toMatch(/not stored \(sanity check failed\)/);
    expect(nightlyResultMessage(summary({ calibration: { jobsConsidered: 1, jobsUsed: 1 } })).message).toMatch(/1 of 1 completed job usable/);
  });

  it('reports failures and skips', () => {
    const failed = nightlyResultMessage(summary({ calibration: { status: 'failed', error: 'There is no active coefficient set.' } }));
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/^Learning run finished with problems\. Calibration failed: There is no active coefficient set\./);
    expect(nightlyResultMessage(summary({ calibration: { status: 'failed' } })).message).toMatch(/Calibration failed: unknown error/);
    const skipped = nightlyResultMessage(summary({ calibration: { status: 'skipped', error: 'Another calibration run is still in progress.' } }));
    expect(skipped.ok).toBe(true);
    expect(skipped.message).toMatch(/Calibration skipped: Another calibration run/);
    expect(nightlyResultMessage(summary({ calibration: { status: 'skipped' } })).message).toMatch(/skipped: another run is in progress/);

    expect(nightlyResultMessage(summary({ winModel: { status: 'failed', error: 'boom' } }))).toMatchObject({ ok: false });
    expect(nightlyResultMessage(summary({ winModel: { status: 'failed' } })).message).toMatch(/Win model failed: unknown error/);
    expect(nightlyResultMessage(summary({ winModel: { status: 'skipped', error: null, reason: 'busy' } })).message).toMatch(/Win model skipped: busy/);
    expect(nightlyResultMessage(summary({ winModel: { status: 'skipped', error: 'still running' } })).message).toMatch(/Win model skipped: still running/);
    expect(nightlyResultMessage(summary({ winModel: { trained: true, nQuotes: 52 } })).message).toMatch(/Win model retrained on 52 decided quotes\./);
    expect(nightlyResultMessage(summary({ winModel: { trained: true, nQuotes: 1 } })).message).toMatch(/on 1 decided quote\./);
  });

  it('mentions expired quotes and scored flags, and their failures', () => {
    const r = nightlyResultMessage(summary({ expiredQuotes: 2, deviationOutcomesUpdated: 1 }));
    expect(r.message).toMatch(/2 stale quotes expired\. 1 deviation flag scored against actuals\.$/);
    expect(nightlyResultMessage(summary({ expiredQuotes: 1, deviationOutcomesUpdated: 3 })).message).toMatch(/1 stale quote expired\. 3 deviation flags/);
    const bad = nightlyResultMessage(summary({ expiredQuotes: null, deviationOutcomesUpdated: null }));
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Expiring stale quotes failed\. Scoring deviation flags failed\.$/);
  });

  it('nightlyHasFailures matches the steps', () => {
    expect(nightlyHasFailures(summary())).toBe(false);
    expect(nightlyHasFailures(summary({ expiredQuotes: null }))).toBe(true);
    expect(nightlyHasFailures(summary({ deviationOutcomesUpdated: null }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Forms and notices
// ---------------------------------------------------------------------------

describe('action forms', () => {
  it('approve takes an optional reason', () => {
    expect(approveForm.parse({ set_id: ID, reason: '  ' })).toEqual({ set_id: ID, reason: null });
    expect(approveForm.parse({ set_id: ID, reason: ' Looks right ' })).toEqual({ set_id: ID, reason: 'Looks right' });
    expect(approveForm.parse({ set_id: ID })).toEqual({ set_id: ID, reason: null });
    expect(approveForm.safeParse({ set_id: 'nope' }).success).toBe(false);
    expect(approveForm.safeParse({ set_id: ID, reason: 'x'.repeat(501) }).success).toBe(false);
  });
  it('reject and restore need a reason', () => {
    expect(decisionForm.parse({ set_id: ID, reason: ' Bad week of data ' })).toEqual({ set_id: ID, reason: 'Bad week of data' });
    const r = decisionForm.safeParse({ set_id: ID, reason: '' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('Reason is required');
    expect(decisionForm.safeParse({ set_id: ID, reason: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('notices', () => {
  it('round-trips through the query string', () => {
    const q = noticeQuery({ kind: 'restored', version: 14, from: 9 });
    expect(q).toBe('?notice=restored&v=14&from=9');
    expect(parseNotice(Object.fromEntries(new URLSearchParams(q)))).toEqual({ kind: 'restored', version: 14, from: 9 });
    expect(noticeQuery({ kind: 'rejected', version: null, from: null })).toBe('?notice=rejected');
  });
  it('ignores anything unexpected', () => {
    expect(parseNotice({})).toBeNull();
    expect(parseNotice({ notice: '<script>' })).toBeNull();
    expect(parseNotice({ notice: ['approved', 'x'], v: ['7'] })).toEqual({ kind: 'approved', version: 7, from: null });
    expect(parseNotice({ notice: 'approved', v: '7abc', from: '3' })).toEqual({ kind: 'approved', version: null, from: null });
    expect(parseNotice({ notice: 'restored', v: '-1', from: '1e3' })).toEqual({ kind: 'restored', version: null, from: null });
  });
  it('explains what happened', () => {
    expect(noticeMessage({ kind: 'approved', version: 12, from: null })).toMatch(/^Candidate v12 approved\. It is now the active set/);
    expect(noticeMessage({ kind: 'approved', version: null, from: null })).toMatch(/^Candidate approved\./);
    expect(noticeMessage({ kind: 'rejected', version: 5, from: null })).toBe('Candidate v5 rejected. Pricing keeps using the active set.');
    expect(noticeMessage({ kind: 'restored', version: 14, from: 9 })).toMatch(/^Version 9 restored as v14\. Pricing uses it now/);
    expect(noticeMessage({ kind: 'restored', version: null, from: null })).toMatch(/^Version restored\. Pricing uses it now/);
  });
});

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

describe('sparkline', () => {
  it('draws a line through the values, oldest left', () => {
    const s = sparkline([0.2, 0.1, 0.15], { width: 100, height: 20, pad: 0 })!;
    expect(s.path).toBe('M0 0 L50 20 L100 10');
    expect(s.points.map((p) => p.index)).toEqual([0, 1, 2]);
  });
  it('breaks the line at gaps and can start the scale at zero', () => {
    const s = sparkline([0.2, null, 0.1, Number.NaN, 0.1], { width: 40, height: 10, pad: 0, zeroBased: true })!;
    expect(s.path).toBe('M0 0 M20 5 M40 5');
    expect(s.points).toHaveLength(3);
  });
  it('centers a single point and flat lines', () => {
    expect(sparkline([0.3], { width: 50, height: 10 })!.path).toBe('M25 5');
    expect(sparkline([0.3, 0.3], { width: 50, height: 10, pad: 5 })!.path).toBe('M5 5 L45 5');
  });
  it('widens the scale to a shared domain', () => {
    // 0.1 on a 0..0.4 scale sits three quarters of the way down.
    expect(sparkline([0.1, 0.1], { width: 10, height: 40, pad: 0, domain: [0, 0.4] })!.path).toBe('M0 30 L10 30');
    expect(sparkline([0.1, 0.2], { width: 10, height: 40, pad: 0, domain: [Number.NaN, 0.4] })!.path).toBe('M0 40 L10 26.67');
  });
  it('is null with nothing to draw', () => {
    expect(sparkline([], { width: 50, height: 10 })).toBeNull();
    expect(sparkline([null, Number.POSITIVE_INFINITY], { width: 50, height: 10 })).toBeNull();
  });
  it('keeps every point inside the box (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.double({ min: -1e6, max: 1e6, noNaN: true }), { nil: null }), { maxLength: 30 }),
        fc.integer({ min: 10, max: 400 }),
        fc.integer({ min: 4, max: 100 }),
        fc.boolean(),
        (values, width, height, zeroBased) => {
          const s = sparkline(values, { width, height, pad: 2, zeroBased });
          const finite = values.filter((v) => v !== null);
          if (!finite.length) {
            expect(s).toBeNull();
            return;
          }
          expect(s!.points).toHaveLength(finite.length);
          for (const p of s!.points) {
            expect(p.x).toBeGreaterThanOrEqual(0);
            expect(p.x).toBeLessThanOrEqual(width);
            expect(p.y).toBeGreaterThanOrEqual(0);
            expect(p.y).toBeLessThanOrEqual(height);
          }
          expect(s!.path).not.toMatch(/NaN|Infinity/);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatting', () => {
  it('formats coefficient values to 4 significant digits', () => {
    expect(formatCoef(1.1)).toBe('1.1');
    expect(formatCoef(0.004)).toBe('0.004');
    expect(formatCoef(0.15234567)).toBe('0.1523');
    expect(formatCoef(12345)).toBe('12350');
    expect(formatCoef(null)).toBe('—');
    expect(formatCoef(Number.NaN)).toBe('—');
  });

  it('formats signed and plain percents', () => {
    expect(formatSignedPct(0.1234)).toBe('+12.3%');
    expect(formatSignedPct(-0.04)).toBe('−4.0%');
    expect(formatSignedPct(0.00001)).toBe('0%');
    expect(formatSignedPct(-0.00001)).toBe('0%');
    expect(formatSignedPct(null)).toBe('—');
    expect(formatSignedPct(0.5, 0)).toBe('+50%');
    expect(formatPct(0.625)).toBe('63%');
    expect(formatPct(0.625, 1)).toBe('62.5%');
    expect(formatPct(undefined)).toBe('—');
  });

  it('signed percent keeps the sign of the change (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: -100, max: 100, noNaN: true }), (p) => {
        const s = formatSignedPct(p);
        if (Math.abs(p) < 0.0005) expect(s).toBe('0%');
        else expect(s.startsWith(p > 0 ? '+' : '−')).toBe(true);
      }),
    );
  });

  it('formats MAPE, standard error, n_eff, confidence and metrics', () => {
    expect(formatMape(0.123)).toBe('12%');
    expect(formatMape(0.1)).toBe('10%');
    expect(formatMape(0.081)).toBe('8.1%');
    expect(formatMape(0.05)).toBe('5%');
    expect(formatMape(null)).toBe('—');
    expect(formatStdError(0.01234)).toBe('± 0.01234');
    expect(formatStdError(-0.5)).toBe('± 0.5');
    expect(formatStdError(null)).toBe('—');
    expect(formatNEff(14.234)).toBe('14.2');
    expect(formatNEff(1234.5)).toBe('1,234.5');
    expect(formatNEff(undefined)).toBe('—');
    expect(confidencePct(81.4)).toBe(81);
    expect(confidencePct(130)).toBe(100);
    expect(confidencePct(-3)).toBe(0);
    expect(confidencePct(null)).toBe(0);
    expect(confidencePct(Number.NaN)).toBe(0);
    expect(formatMetric(0.7143)).toBe('0.71');
    expect(formatMetric(null)).toBe('—');
    expect(formatCount(1234)).toBe('1,234');
    expect(plural(1, 'job')).toBe('job');
    expect(plural(0, 'job')).toBe('jobs');
  });

  it('formats dates and times in Eastern time', () => {
    // 07:15 UTC is 3:15 AM EDT in October and 2:15 AM EST in January.
    expect(formatDateTime('2026-10-20T07:15:00Z')).toBe('Oct 20, 2026, 3:15 AM');
    expect(formatDateTime('2027-01-12T07:15:00Z')).toBe('Jan 12, 2027, 2:15 AM');
    // Just after midnight UTC is still the previous day in Newark.
    expect(formatDate('2026-10-21T02:30:00Z')).toBe('Oct 20, 2026');
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('not a date')).toBe('—');
    expect(formatDate(undefined)).toBe('—');
  });

  it('formats run durations', () => {
    const t = '2026-10-20T07:15:00Z';
    expect(formatDuration(t, '2026-10-20T07:15:42Z')).toBe('42 s');
    expect(formatDuration(t, '2026-10-20T07:18:05Z')).toBe('3 min 5 s');
    expect(formatDuration(t, '2026-10-20T07:17:00Z')).toBe('2 min');
    expect(formatDuration(t, '2026-10-20T08:17:00Z')).toBe('1 h 2 min');
    expect(formatDuration(t, '2026-10-20T09:15:00Z')).toBe('2 h');
    expect(formatDuration(t, '2026-10-20T07:14:00Z')).toBe('0 s');
    expect(formatDuration(t, null)).toBeNull();
    expect(formatDuration('bad', t)).toBeNull();
  });
});
