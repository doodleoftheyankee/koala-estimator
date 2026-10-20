import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ACCESS_LEVELS, JOB_TYPES, PRODUCTS } from '@/lib/pricing';
import { calibrate } from './calibrate';
import type { CalibrationInput, DriveObservation, LearningSettings, Observation, StoredCoefficient } from './types';
import { seedActive } from './__fixtures__/synthetic';

const now = new Date('2026-10-20T12:00:00Z');
const DAY = 86_400_000;

const date = fc.oneof(
  { weight: 12, arbitrary: fc.integer({ min: -30, max: 1500 }).map((d) => new Date(now.getTime() - d * DAY).toISOString()) },
  { weight: 1, arbitrary: fc.constantFrom('', 'garbage') },
);
// Mostly plausible numbers, sometimes junk: zero, negative, absurd, non-finite.
const amount = (min: number, max: number) =>
  fc.oneof(
    { weight: 8, arbitrary: fc.double({ min, max, noNaN: true }) },
    { weight: 1, arbitrary: fc.constantFrom(0, -3, 1e15, Number.NaN, Number.POSITIVE_INFINITY) },
  );
const maybe = (min: number, max: number) => fc.option(amount(min, max), { nil: null, freq: 6 });

const observation: fc.Arbitrary<Observation> = fc.record({
  jobId: fc.constantFrom('j1', 'j2', 'j3', 'j4', 'j5', 'j6'),
  areaId: fc.constantFrom('a1', 'a2'),
  completedAt: date,
  product: fc.constantFrom(...PRODUCTS),
  jobType: fc.constantFrom(...JOB_TYPES),
  accessLevel: fc.constantFrom(...ACCESS_LEVELS),
  sqft: amount(50, 5000),
  designQty: maybe(0.5, 10000),
  modelQty: fc.constant(null),
  estQty: fc.constant(null),
  modelHours: fc.constant(null),
  estHours: fc.constant(null),
  actualQty: maybe(0.5, 15000),
  actualHours: maybe(0.1, 300),
});

const drive: fc.Arbitrary<DriveObservation> = fc.record({
  jobId: fc.constantFrom('j1', 'j2', 'j3'),
  completedAt: date,
  estMinutes: amount(1, 120),
  actualMinutes: amount(1, 240),
});

/** The seeded active set with every value moved somewhere inside its bounds. */
const active: fc.Arbitrary<StoredCoefficient[]> = fc
  .array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: seedActive().length, maxLength: seedActive().length })
  .map((fs) => seedActive().map((c, i) => ({ ...c, value: c.lowerBound + fs[i]! * (c.upperBound - c.lowerBound) })));

const settings: fc.Arbitrary<LearningSettings> = fc.record({
  halfLifeDays: fc.double({ min: 1, max: 2000, noNaN: true }),
  shrinkageK: fc.double({ min: 0, max: 20, noNaN: true }),
  minNEff: fc.double({ min: 0, max: 8, noNaN: true }),
  maxStepPct: fc.double({ min: 0, max: 3, noNaN: true }),
  holdoutFrac: fc.double({ min: 0.05, max: 0.6, noNaN: true }),
  winsorPct: fc.double({ min: 0, max: 0.3, noNaN: true }),
  autoPromote: fc.boolean(),
  minQuotesForWinModel: fc.constant(40),
  winHalfLifeDays: fc.constant(365),
  winL2: fc.constant(1),
});

const input: fc.Arbitrary<CalibrationInput> = fc.record({
  observations: fc.array(observation, { maxLength: 60 }),
  drive: fc.array(drive, { maxLength: 8 }),
  active,
  settings,
  now: fc.constant(now),
});

/** The value pricing used for this scope before the run: its own active value, or its parent's. */
function startingValue(act: readonly StoredCoefficient[], c: StoredCoefficient): number {
  const same = (x: StoredCoefficient, jobType: StoredCoefficient['jobType']) =>
    x.kind === c.kind && x.product === c.product && x.jobType === jobType && x.accessLevel === c.accessLevel;
  return (act.find((x) => same(x, c.jobType)) ?? act.find((x) => same(x, null))!).value;
}

describe('calibrate invariants (property-based)', () => {
  it('never produces NaN, never leaves the bounds, never steps further than the limit', () => {
    fc.assert(
      fc.property(input, (inp) => {
        const r = calibrate(inp);
        const step = inp.settings.maxStepPct;
        expect(r.coefficients.length).toBeGreaterThanOrEqual(inp.active.length);
        // Every active coefficient is carried, in order.
        inp.active.forEach((a, i) => expect(r.coefficients[i]).toMatchObject({ kind: a.kind, product: a.product, jobType: a.jobType, accessLevel: a.accessLevel }));
        for (const c of r.coefficients) {
          for (const n of [c.value, c.priorValue, c.lowerBound, c.upperBound, c.sampleSize, c.nEff, c.confidence]) expect(Number.isFinite(n)).toBe(true);
          if (c.stdError !== null) expect(c.stdError).toBeGreaterThanOrEqual(0);
          expect(c.value).toBeGreaterThan(0);
          expect(c.value).toBeGreaterThanOrEqual(c.lowerBound);
          expect(c.value).toBeLessThanOrEqual(c.upperBound);
          expect(c.confidence).toBeGreaterThanOrEqual(0);
          expect(c.confidence).toBeLessThanOrEqual(100);
          const v0 = startingValue(inp.active, c);
          expect(Math.abs(c.value - v0)).toBeLessThanOrEqual(step * v0 * (1 + 1e-9) + 1e-12);
          if (!c.changed) expect(Math.abs(c.value - v0)).toBeLessThanOrEqual(1e-9);
        }
        expect(r.changedCount).toBe(r.coefficients.filter((c) => c.changed).length);
        expect(r.gates.find((g) => g.name === 'sanity')!.passed).toBe(true);
        expect(r.passed).toBe(r.gates.every((g) => g.passed));
        if (r.autoPromotable) expect(r.passed && inp.settings.autoPromote).toBe(true);
        expect(r.metrics.nUsed).toBeLessThanOrEqual(r.metrics.nObservations);
        for (const m of Object.values(r.metrics.holdout ?? {})) if (m !== null) expect(Number.isFinite(m)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(input, (inp) => {
        expect(calibrate(inp)).toEqual(calibrate(inp));
      }),
      { numRuns: 40 },
    );
  });
});
