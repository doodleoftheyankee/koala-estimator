// updateDeviationOutcomes against an in-memory stand-in for supabase-js: which rows it reads, which
// columns it selects, and what it writes. The scoring rules themselves are in nightlyCore.test.ts.
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { priceEstimate, type EstimateInput, type Tier } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { computeDeviationFlags } from './deviation';
import { updateDeviationOutcomes } from './io';

vi.mock('server-only', () => ({}));

type Row = Record<string, unknown>;
interface Call {
  table: string;
  columns: string | null;
  update: Row | null;
  filters: string[];
}

/** PostgREST's select list as io.ts writes it: plain columns and `alias:column->field`. */
function project(row: Row, columns: string): Row {
  const out: Row = {};
  for (const c of columns.split(',').map((s) => s.trim())) {
    const json = /^(\w+):(\w+)->(\w+)$/.exec(c);
    if (json) out[json[1]!] = (row[json[2]!] as Row | null)?.[json[3]!] ?? null;
    else out[c] = row[c];
  }
  return out;
}

/** Enough of the query builder for io.ts: select or update, eq/is/not/in filters, order, range. */
function fakeAdmin(tables: Record<string, Row[]>) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, columns: null, update: null, filters: [] };
    calls.push(call);
    let rows = tables[table] ?? [];
    const q = {} as Record<string, unknown>;
    const where = (desc: string, keep: (r: Row) => boolean) => {
      call.filters.push(desc);
      rows = rows.filter(keep);
      return q;
    };
    Object.assign(q, {
      select: (columns: string) => {
        if (!call.update) call.columns = columns;
        return q;
      },
      update: (patch: Row) => {
        call.update = patch;
        return q;
      },
      eq: (col: string, v: unknown) => where(`${col} = ${String(v)}`, (r) => r[col] === v),
      is: (col: string) => where(`${col} is null`, (r) => r[col] == null),
      not: (col: string) => where(`${col} is not null`, (r) => r[col] != null),
      in: (col: string, vs: unknown[]) => where(`${col} in (${vs.join(',')})`, (r) => vs.includes(r[col])),
      order: () => q,
      range: async (lo: number, hi: number) => ({ data: rows.slice(lo, hi + 1).map((r) => project(r, call.columns!)), error: null }),
      // An awaited update(...).select('id').
      then: (resolve: (v: unknown) => void) => {
        for (const r of rows) Object.assign(r, call.update);
        resolve({ data: rows.map((r) => ({ id: r.id })), error: null });
      },
    });
    return q;
  };
  return { admin: { from } as unknown as SupabaseClient, calls };
}

// 1000 sq ft attic at R-19: Better tops it up with 62 bags of cellulose, Best removes it and blows 90.
const attic = estimate({ areas: [area({ currentR: 19 })] });

/** deviation_flags rows as sync_upsert_estimate stores them for this version of the estimate. */
const flagRows = (estimateId: string, input: EstimateInput): Row[] =>
  computeDeviationFlags(priceEstimate(input, snapshot, coefficients), input, { snapshot, coefficientSet: coefficients }).map((f) => ({
    id: `${estimateId}:${f.key}`,
    estimate_id: estimateId,
    flag_key: f.key,
    metric: f.metric,
    tier: f.tier,
    estimator_value: f.estimatorValue,
    model_value: f.modelValue,
    outcome: null,
  }));

/** A signed quote row with the whole snapshot, document included. */
const quoteRow = (id: string, input: EstimateInput, tier: Tier): Row => ({
  id,
  signed_tier: tier,
  snapshot: JSON.parse(
    JSON.stringify({
      document: { recommendedTier: 'better', terms: 'x'.repeat(5000) },
      options: priceEstimate(input, snapshot, coefficients).options,
      input: { areas: [], driveMinutesOneWay: 20 },
    }),
  ),
});

const actualRow = (jobId: string, product: string, patch: Row = {}): Row => ({
  id: `${jobId}:${product}`,
  job_id: jobId,
  area_id: 'a1',
  product,
  actual_material_qty: null,
  actual_hours: null,
  actual_drive_minutes: null,
  verified_at: '2026-10-02T15:00:00Z',
  exclude_from_learning: false,
  ...patch,
});

const job = (id: string, estimateId: string, quoteId: string, status = 'completed'): Row => ({
  id,
  quote_id: quoteId,
  estimate_id: estimateId,
  status,
  completed_at: '2026-10-01T16:00:00Z',
});

describe('updateDeviationOutcomes', () => {
  it('scores the signed tier from the quote options and writes each outcome once', async () => {
    // e1: the estimator raised the cellulose on Better (90 bags vs 62); the customer signed Best
    // (131 vs 90) and the crew used 90 bags. e2: the job is still in progress.
    const bags = { 'a1|cellulose|material': { qty: 90, reason: 'Deep joist bays', tier: 'better' as const } };
    const e1 = { ...attic, lineOverrides: bags };
    const tables = {
      deviation_flags: [...flagRows('e1', e1), ...flagRows('e2', e1)],
      jobs: [job('job-1', 'e1', 'q1'), job('job-2', 'e2', 'q2', 'in_progress')],
      job_actuals: [actualRow('job-1', 'cellulose', { actual_material_qty: 90, actual_hours: 15 })],
      quotes: [quoteRow('q1', e1, 'best'), quoteRow('q2', e1, 'better')],
    };
    const { admin, calls } = fakeAdmin(tables);

    expect(await updateDeviationOutcomes(admin)).toBe(1);
    const outcomes = Object.fromEntries(tables.deviation_flags.map((f) => [f.id, f.outcome]));
    expect(outcomes).toEqual({
      'e1:a1|cellulose|material|qty': 'model_closer', // the flag row alone (90 vs 62) said estimator_closer
      'e1:better|total_price': null,
      'e1:best|total_price': null,
      'e2:a1|cellulose|material|qty': null,
      'e2:better|total_price': null,
      'e2:best|total_price': null,
    });

    // Only the job's quote, and only its options: the snapshot's document is never loaded.
    const quoteReads = calls.filter((c) => c.table === 'quotes');
    expect(new Set(quoteReads.map((c) => `${c.columns} | ${c.filters.join(' & ')}`))).toEqual(
      new Set(['id, signed_tier, options:snapshot->options | id in (q1)']),
    );
    const writes = calls.filter((c) => c.update);
    expect(writes).toEqual([
      {
        table: 'deviation_flags',
        columns: null,
        update: { outcome: 'model_closer' },
        filters: ['id in (e1:a1|cellulose|material|qty)', 'outcome is null'],
      },
    ]);

    // A rerun has nothing left to score and reads no quote.
    const rerun = fakeAdmin(tables);
    expect(await updateDeviationOutcomes(rerun.admin)).toBe(0);
    expect(rerun.calls.some((c) => c.table === 'quotes' || c.update)).toBe(false);
  });

  it('scores the quote that was signed, not a revision synced after it', async () => {
    // v1 (13 h of cellulose labor on Better) was signed; a later, unsent revision with 18 h and an
    // air sealing change is what deviation_flags holds. The crew took 12.8 h and 9 h.
    const v1 = { ...attic, lineOverrides: { 'a1|cellulose|labor': { hours: 13, reason: 'Low clearance', tier: 'better' as const } } };
    const revision = {
      ...attic,
      lineOverrides: {
        'a1|cellulose|labor': { hours: 18, reason: 'Low clearance', tier: 'better' as const },
        'a1|air_sealing|labor': { hours: 9, reason: 'Many penetrations', tier: 'better' as const },
      },
    };
    const tables = {
      deviation_flags: flagRows('e1', revision),
      jobs: [job('job-1', 'e1', 'q1')],
      job_actuals: [actualRow('job-1', 'cellulose', { actual_hours: 12.8 }), actualRow('job-1', 'air_sealing', { actual_hours: 9 })],
      quotes: [quoteRow('q1', v1, 'better')],
    };
    const { admin } = fakeAdmin(tables);

    expect(await updateDeviationOutcomes(admin)).toBe(1);
    const outcomes = Object.fromEntries(tables.deviation_flags.filter((f) => f.metric === 'hours').map((f) => [f.flag_key, f.outcome]));
    expect(outcomes).toEqual({
      'a1|cellulose|labor|hours': 'estimator_closer', // the row's 18 h vs 10.54 would have said model_closer
      'a1|air_sealing|labor|hours': null, // never quoted, so never judged
    });
  });

  it('leaves a flag open when its line is not in the signed option, reading only the options', async () => {
    // Removal is only part of Best; the customer signed Better, and the crew still logged removal hours.
    const input = { ...attic, lineOverrides: { 'a1|removal|removal': { hours: 28, reason: 'Wet insulation', tier: 'best' as const } } };
    const tables = {
      deviation_flags: flagRows('e1', input),
      jobs: [job('job-1', 'e1', 'q1')],
      job_actuals: [actualRow('job-1', 'removal', { actual_hours: 27 })],
      quotes: [quoteRow('q1', input, 'better')],
    };
    const { admin, calls } = fakeAdmin(tables);

    expect(await updateDeviationOutcomes(admin)).toBe(0);
    expect(tables.deviation_flags.every((f) => f.outcome === null)).toBe(true);
    expect(calls.some((c) => c.update)).toBe(false);
    expect(new Set(calls.filter((c) => c.table === 'quotes').map((c) => c.columns))).toEqual(
      new Set(['id, signed_tier, options:snapshot->options']),
    );
  });

  it('reads no quote while flags wait for verified actuals', async () => {
    const input = { ...attic, lineOverrides: { 'a1|cellulose|labor': { hours: 13, reason: 'Low clearance', tier: 'better' as const } } };
    const tables = {
      deviation_flags: flagRows('e1', input),
      jobs: [job('job-1', 'e1', 'q1')],
      job_actuals: [actualRow('job-1', 'cellulose', { actual_hours: 12.8, verified_at: null })],
      quotes: [quoteRow('q1', input, 'better')],
    };
    const { admin, calls } = fakeAdmin(tables);
    expect(await updateDeviationOutcomes(admin)).toBe(0);
    expect(calls.map((c) => c.table)).not.toContain('quotes');
  });
});
