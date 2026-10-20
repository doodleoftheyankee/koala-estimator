import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { findStored, predictHours, predictQty, toCoefficientSet } from './predict';
import type { Observation, StoredCoefficient } from './types';
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

const active = seedActive();
const set = toCoefficientSet(active);

describe('toCoefficientSet and findStored', () => {
  it('maps every stored coefficient with its evidence', () => {
    expect(set.coefficients).toHaveLength(active.length);
    expect(set.coefficients[0]).toEqual({
      kind: 'waste_factor',
      product: 'ocsf',
      jobType: null,
      accessLevel: null,
      value: 1.1,
      sampleSize: 0,
      nEff: 0,
      confidence: 0,
    });
  });

  it('returns the stored coefficient the engine would use (most specific wins)', () => {
    const attic = findStored(active, 'removal_hrs_per_sqft', { jobType: 'attic' });
    expect(attic?.value).toBe(0.02);
    expect(attic?.upperBound).toBe(0.1);
    expect(findStored(active, 'removal_hrs_per_sqft', { jobType: 'walls' })?.value).toBe(0.025);
    expect(findStored(active, 'photo_area_bias', {})).toBeNull();
  });
});

describe('predictHours', () => {
  it('uses setup + designQty x rate x access', () => {
    expect(predictHours(set, obs({ accessLevel: 'difficult' }))).toBeCloseTo(2 + 50 * 0.15 * 1.35, 12);
  });

  it('uses setup(removal) + sqft x removal rate(job type) x access for removal rows', () => {
    const o = obs({ product: 'removal', designQty: null, jobType: 'crawlspace', accessLevel: 'moderate', sqft: 400 });
    expect(predictHours(set, o)).toBeCloseTo(1 + 400 * 0.03 * 1.15, 12);
  });

  it('treats a missing setup as 0, like the engine', () => {
    const noSetup = toCoefficientSet(active.filter((c) => c.kind !== 'setup_hours'));
    expect(predictHours(noSetup, obs())).toBeCloseTo(50 * 0.15, 12);
    expect(predictHours(noSetup, obs({ product: 'removal', designQty: null }))).toBeCloseTo(1000 * 0.02, 12);
  });

  it('is null when the engine could not price the row', () => {
    const without = (kind: StoredCoefficient['kind']) => toCoefficientSet(active.filter((c) => c.kind !== kind));
    expect(predictHours(without('access_mult'), obs())).toBeNull();
    expect(predictHours(without('labor_hrs_per_unit'), obs())).toBeNull();
    expect(predictHours(without('removal_hrs_per_sqft'), obs({ product: 'removal', designQty: null }))).toBeNull();
    expect(predictHours(set, obs({ designQty: null }))).toBeNull();
    expect(predictHours(set, obs({ designQty: 0 }))).toBeNull();
    expect(predictHours(set, obs({ product: 'removal', designQty: null, sqft: 0 }))).toBeNull();
  });

  it('matches the pricing engine for the same inputs', () => {
    const input = estimate({ areas: [area({ accessLevel: 'difficult', removalNeeded: true, currentR: 11 })] });
    const best = priceEstimate(input, snapshot, coefficients).options.find((o) => o.tier === 'best')!;
    for (const line of best.lines.filter((l) => l.kind === 'labor' || l.kind === 'removal')) {
      const material = best.lines.find((l) => l.kind === 'material' && l.product === line.product);
      const o = obs({
        product: line.product!,
        accessLevel: 'difficult',
        designQty: line.kind === 'removal' ? null : (material?.designQty ?? 1000),
      });
      expect(predictHours(coefficients, o)).toBeCloseTo(line.modelHours!, 1);
    }
  });
});

describe('predictQty', () => {
  it('is designQty x waste, unrounded', () => {
    expect(predictQty(set, obs({ designQty: 33.3 }))).toBeCloseTo(33.3 * 1.08, 12);
  });

  it('uses waste 1 for air sealing without a factor, null for other products without one', () => {
    expect(predictQty(set, obs({ product: 'air_sealing', designQty: 800 }))).toBe(800);
    const noWaste = toCoefficientSet(active.filter((c) => c.kind !== 'waste_factor'));
    expect(predictQty(noWaste, obs())).toBeNull();
  });

  it('is null for removal and rows without a design quantity', () => {
    expect(predictQty(set, obs({ product: 'removal' }))).toBeNull();
    expect(predictQty(set, obs({ designQty: null }))).toBeNull();
    expect(predictQty(set, obs({ designQty: -1 }))).toBeNull();
  });
});
