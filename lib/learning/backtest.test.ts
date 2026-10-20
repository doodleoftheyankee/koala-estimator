import { describe, expect, it } from 'vitest';
import {
  backtestGate,
  compareObservations,
  evaluateHoldout,
  holdoutSplit,
  mape,
  MIN_BACKTEST_N,
  MIN_HOLDOUT_ROWS,
  sortDrive,
  sortObservations,
} from './backtest';
import { toCoefficientSet } from './predict';
import type { Observation } from './types';
import { seedActive } from './__fixtures__/synthetic';

const obs = (o: Partial<Observation> = {}): Observation => ({
  jobId: 'j1',
  areaId: 'a1',
  completedAt: '2026-10-01T12:00:00Z',
  product: 'cellulose',
  jobType: 'attic',
  accessLevel: 'easy',
  sqft: 1000,
  designQty: 50,
  modelQty: null,
  estQty: null,
  modelHours: null,
  estHours: null,
  actualQty: null,
  actualHours: null,
  ...o,
});

describe('ordering and split', () => {
  it('orders by completion time, then job, area and product', () => {
    const a = obs({ completedAt: '2026-10-01T12:00:00-04:00' }); // 16:00Z, later than b
    const b = obs({ completedAt: '2026-10-01T13:00:00Z' });
    expect(compareObservations(a, b)).toBe(1);
    expect(compareObservations(obs({ jobId: 'j2' }), obs({ jobId: 'j1' }))).toBe(1);
    expect(compareObservations(obs({ areaId: 'a0' }), obs({ areaId: 'a1' }))).toBe(-1);
    expect(compareObservations(obs({ product: 'removal' }), obs({ product: 'cellulose' }))).toBe(1);
    expect(compareObservations(obs(), obs())).toBe(0);
  });

  it('sorts a copy', () => {
    const rows = [obs({ jobId: 'b' }), obs({ jobId: 'a' })];
    const sorted = sortObservations(rows);
    expect(sorted.map((o) => o.jobId)).toEqual(['a', 'b']);
    expect(rows[0]!.jobId).toBe('b');
  });

  it('breaks ties between duplicate rows on their values, nulls first', () => {
    const rows = [obs({ actualHours: 5 }), obs({ actualHours: null }), obs({ actualHours: 3 }), obs({ designQty: null })];
    const sorted = sortObservations(rows);
    expect(sortObservations([...rows].reverse())).toEqual(sorted);
    expect(sorted.map((o) => [o.designQty, o.actualHours])).toEqual([
      [null, null],
      [50, null],
      [50, 3],
      [50, 5],
    ]);
  });

  it('sorts drive rows by date, job, then minutes', () => {
    const d = (jobId: string, completedAt: string, estMinutes: number, actualMinutes: number) => ({ jobId, completedAt, estMinutes, actualMinutes });
    const rows = [
      d('j2', '2026-10-02T00:00:00Z', 20, 25),
      d('j1', '2026-10-02T00:00:00Z', 20, 30),
      d('j1', '2026-10-02T00:00:00Z', 20, 25),
      d('j1', '2026-10-02T00:00:00Z', 10, 25),
      d('j9', '2026-10-01T00:00:00Z', 20, 25),
    ];
    expect(sortDrive(rows).map((r) => `${r.jobId}:${r.estMinutes}:${r.actualMinutes}`)).toEqual([
      'j9:20:25',
      'j1:10:25',
      'j1:20:25',
      'j1:20:30',
      'j2:20:25',
    ]);
  });

  it('holds out the last ceil(frac x n) rows, with at least one row on each side', () => {
    const xs = Array.from({ length: 23 }, (_, i) => i);
    expect(holdoutSplit(xs.slice(0, MIN_BACKTEST_N - 1), 0.2)).toBeNull();
    const split = holdoutSplit(xs, 0.2)!;
    expect(split.holdout).toEqual([18, 19, 20, 21, 22]);
    expect(split.train).toHaveLength(18);
    expect(holdoutSplit(xs.slice(0, 10), 0.999)!.train).toEqual([0]);
    expect(holdoutSplit(xs.slice(0, 10), 0.0001)!.holdout).toEqual([9]);
  });
});

describe('mape', () => {
  it('is the mean absolute percentage error, null without rows', () => {
    expect(mape([{ predicted: 11, actual: 10 }, { predicted: 7, actual: 10 }])).toBeCloseTo(0.2, 12);
    expect(mape([])).toBeNull();
  });
});

describe('evaluateHoldout', () => {
  const active = toCoefficientSet(seedActive());
  const candidate = toCoefficientSet(seedActive().map((c) => (c.kind === 'labor_hrs_per_unit' ? { ...c, value: c.value * 1.1 } : c)));

  it('scores hours and quantity for both sets on the same rows', () => {
    // Active predicts 2 + 50 x 0.15 = 9.5 h and 54 bags; candidate 2 + 50 x 0.165 = 10.25 h.
    const ev = evaluateHoldout([obs({ actualHours: 10, actualQty: 54 })], active, candidate);
    expect(ev.usable).toBe(1);
    expect(ev.metrics.n).toBe(1);
    expect(ev.metrics.hoursMapeActive).toBeCloseTo(0.05, 12);
    expect(ev.metrics.hoursMapeCandidate).toBeCloseTo(0.025, 12);
    expect(ev.metrics.qtyMapeActive).toBeCloseTo(0, 12);
    expect(ev.metrics.qtyMapeCandidate).toBeCloseTo(0, 12);
  });

  it('skips rows with no actual, an actual <= 0, or no prediction', () => {
    const ev = evaluateHoldout(
      [
        obs(),
        obs({ actualHours: 0, actualQty: -2 }),
        obs({ designQty: null, actualHours: 5, actualQty: 5 }),
        obs({ product: 'removal', designQty: null, actualHours: 21, actualQty: 3 }),
      ],
      active,
      candidate,
    );
    expect(ev.usable).toBe(1);
    expect(ev.metrics.n).toBe(4);
    expect(ev.metrics.qtyMapeActive).toBeNull();
    expect(ev.metrics.hoursMapeActive).toBeCloseTo(0, 12);
  });
});

describe('backtestGate', () => {
  const ev = (usable: number, ha: number | null, hc: number | null, qa: number | null = null, qc: number | null = null) => ({
    usable,
    metrics: { n: usable, hoursMapeActive: ha, hoursMapeCandidate: hc, qtyMapeActive: qa, qtyMapeCandidate: qc },
  });

  it('passes but is insufficient without a holdout', () => {
    const r = backtestGate(null, 4);
    expect(r).toMatchObject({ sufficient: false, gate: { name: 'backtest', passed: true } });
    expect(r.gate.detail).toMatch(/Insufficient data/);
  });

  it('passes but is insufficient with too few usable rows', () => {
    const r = backtestGate(ev(MIN_HOLDOUT_ROWS - 1, 0.1, 0.5), 30);
    expect(r).toMatchObject({ sufficient: false, gate: { passed: true } });
    expect(r.gate.detail).toMatch(/Insufficient holdout/);
  });

  it('fails when the candidate is worse on any metric with data', () => {
    expect(backtestGate(ev(10, 0.1, 0.12), 50).gate.passed).toBe(false);
    const both = backtestGate(ev(10, 0.1, 0.12, 0.05, 0.06), 50);
    expect(both.gate.detail).toMatch(/worse on hours and quantity/);
    expect(backtestGate(ev(10, 0.1, 0.09, 0.05, 0.07), 50).gate.passed).toBe(false);
  });

  it('tolerates holdout noise: within 2% relative + 0.5 points of the active MAPE passes', () => {
    expect(backtestGate(ev(10, 0.1, 0.106, 0.05, 0.055), 50).gate.passed).toBe(true);
    expect(backtestGate(ev(10, 0.1, 0.1071, null, null), 50).gate.passed).toBe(false);
  });

  it('passes when no worse (within float tolerance) and reports the numbers', () => {
    const r = backtestGate(ev(10, 0.1, 0.1 + 1e-12, null, null), 50);
    expect(r).toMatchObject({ sufficient: true, gate: { passed: true } });
    expect(r.gate.detail).toContain('active 10.0% vs candidate 10.0%');
    expect(r.gate.detail).toContain('n/a');
    expect(backtestGate(ev(10, null, null, 0.08, 0.04), 50).gate.passed).toBe(true);
  });
});
