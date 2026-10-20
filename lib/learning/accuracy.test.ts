import { describe, expect, it } from 'vitest';
import { estimateAccuracy } from './accuracy';
import type { Observation } from './types';

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

describe('estimateAccuracy', () => {
  it('is empty without rows', () => {
    expect(estimateAccuracy([])).toEqual({
      n: 0,
      hoursMapeModel: null,
      hoursMapeEstimator: null,
      qtyMapeModel: null,
      qtyMapeEstimator: null,
    });
  });

  it('scores model and estimator separately against the actuals', () => {
    const r = estimateAccuracy([
      obs({ modelHours: 9, estHours: 12, actualHours: 10, modelQty: 55, estQty: 60, actualQty: 50 }),
      obs({ modelHours: 11, estHours: null, actualHours: 10 }),
      obs({ product: 'removal', modelHours: 20, estHours: 25, actualHours: 25 }),
    ]);
    expect(r.n).toBe(3);
    expect(r.hoursMapeModel).toBeCloseTo((0.1 + 0.1 + 0.2) / 3, 12);
    expect(r.hoursMapeEstimator).toBeCloseTo((0.2 + 0) / 2, 12);
    expect(r.qtyMapeModel).toBeCloseTo(0.1, 12);
    expect(r.qtyMapeEstimator).toBeCloseTo(0.2, 12);
  });

  it('ignores rows with actual <= 0 and rows with nothing to compare', () => {
    const r = estimateAccuracy([
      obs({ modelHours: 9, actualHours: 0 }),
      obs({ modelQty: 9, actualQty: -1 }),
      obs({ modelHours: null, estHours: null, actualHours: 10 }),
      obs({ modelHours: Number.NaN, actualHours: 10 }),
      obs({ estQty: 45, actualQty: 50 }),
    ]);
    expect(r.n).toBe(1);
    expect(r.hoursMapeModel).toBeNull();
    expect(r.qtyMapeModel).toBeNull();
    expect(r.qtyMapeEstimator).toBeCloseTo(0.1, 12);
  });
});
