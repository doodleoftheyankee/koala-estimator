import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { predictWin, recommendPrice } from '@/lib/learning/winRate';
import { priceEstimate, type WinModel } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { beyondOverrideLimit, primaryJobType, priceAdvice, recommendationReason, totalSqft, winFeaturesFor } from './priceAdvice';

// A plausible market: win chance falls as the markup rises; walls jobs win a bit more often.
const model: WinModel = {
  id: 'wm-1',
  trainedAt: '2026-10-19T06:15:00.000Z',
  nQuotes: 87,
  weights: { intercept: 4, markup: -2.4, log_sqft: 0.05, 'job:walls': 0.4 },
  jobTypes: ['walls'],
  sources: [],
  metrics: { logLoss: 0.6, auc: 0.71, baseRate: 0.45 },
};
const settings = snapshot.settings;

describe('primaryJobType / totalSqft', () => {
  it('the largest area decides the job type; the first wins a tie (as in training)', () => {
    expect(primaryJobType([area({ jobType: 'attic', sqft: 800 }), area({ jobType: 'walls', sqft: 1200 })])).toBe('walls');
    expect(primaryJobType([area({ jobType: 'crawlspace', sqft: 900 }), area({ jobType: 'attic', sqft: 900 })])).toBe('crawlspace');
    expect(primaryJobType([])).toBeNull();
  });

  it('skips sizes that are not numbers', () => {
    expect(primaryJobType([{ jobType: 'attic', sqft: Number.NaN }, { jobType: 'walls', sqft: 10 }])).toBe('walls');
    expect(primaryJobType([{ jobType: 'attic', sqft: Number.NaN }])).toBeNull();
    expect(totalSqft([{ jobType: 'attic', sqft: Number.NaN }, { jobType: 'walls', sqft: 10 }, { jobType: 'x', sqft: 5.5 }])).toBe(15.5);
    expect(totalSqft([])).toBe(0);
  });

  it('several areas of a smaller job type do not outvote the single largest area', () => {
    const areas = [area({ jobType: 'walls', sqft: 300 }), area({ jobType: 'walls', sqft: 300 }), area({ jobType: 'attic', sqft: 500 })];
    expect(primaryJobType(areas)).toBe('attic');
    expect(totalSqft(areas)).toBe(1100);
  });

  it('builds the features with no lead source', () => {
    expect(winFeaturesFor([area({ jobType: 'attic', sqft: 1000 }), area({ jobType: 'walls', sqft: 400 })])).toEqual({ jobType: 'attic', source: null, sqft: 1400 });
    expect(winFeaturesFor([])).toBeNull();
  });
});

describe('priceAdvice', () => {
  const priced = priceEstimate(estimate(), snapshot, coefficients);
  const better = priced.options.find((o) => o.tier === 'better')!;
  const features = winFeaturesFor([area()])!;

  it('scores the current price and finds the expected-profit optimum with the win model', () => {
    const advice = priceAdvice(model, better, features, settings)!;
    expect(advice).not.toBeNull();
    const p = predictWin(model, { ...features, markup: better.price / better.loadedCost });
    expect(advice.current.price).toBe(better.price);
    expect(advice.current.winProbability).toBeCloseTo(p, 12);
    expect(advice.current.expectedProfit).toBeCloseTo(p * (better.price - better.loadedCost), 2);
    expect(advice.best).toEqual(recommendPrice(model, better.loadedCost, features, settings));
    // The recommendation is the best point on its own curve.
    for (const pt of advice.best.curve) expect(pt.expectedProfit).toBeLessThanOrEqual(advice.best.expectedProfit);
    expect(advice.atBest).toBe(Math.abs(better.price - advice.best.price) < 0.005);
  });

  it('knows when the estimator already is at the recommended price', () => {
    const first = priceAdvice(model, better, features, settings)!;
    const at = priceAdvice(model, { price: first.best.price, loadedCost: better.loadedCost }, features, settings)!;
    expect(at.atBest).toBe(true);
    expect(at.current.winProbability).toBeCloseTo(at.best.winProbability, 12);
    expect(at.current.expectedProfit).toBeCloseTo(at.best.expectedProfit, 2);
  });

  it('a higher price always has a lower win chance with this model', () => {
    const lo = priceAdvice(model, { price: better.price, loadedCost: better.loadedCost }, features, settings)!;
    const hi = priceAdvice(model, { price: better.price * 1.3, loadedCost: better.loadedCost }, features, settings)!;
    expect(hi.current.winProbability).toBeLessThan(lo.current.winProbability);
    // The recommendation depends only on cost, not on the price the estimator typed.
    expect(hi.best).toEqual(lo.best);
  });

  it('is null instead of NaN for unusable costs, prices or settings', () => {
    expect(priceAdvice(model, { price: 1000, loadedCost: 0 }, features, settings)).toBeNull();
    expect(priceAdvice(model, { price: 1000, loadedCost: -5 }, features, settings)).toBeNull();
    expect(priceAdvice(model, { price: 1000, loadedCost: Number.NaN }, features, settings)).toBeNull();
    expect(priceAdvice(model, { price: 0, loadedCost: 500 }, features, settings)).toBeNull();
    expect(priceAdvice(model, { price: Number.POSITIVE_INFINITY, loadedCost: 500 }, features, settings)).toBeNull();
    expect(priceAdvice(model, { price: 1000, loadedCost: 500 }, features, { ...settings, floorMarginPct: Number.NaN })).toBeNull();
  });

  it('a malformed cached model gives no advice instead of crashing the Options step', () => {
    const broken = { ...model, weights: undefined } as unknown as WinModel;
    expect(priceAdvice(broken, better, features, settings)).toBeNull();
    expect(priceAdvice(null as unknown as WinModel, better, features, settings)).toBeNull();
  });

  it('never returns NaN and stays within the margin range for any cost (property)', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 200_000, noNaN: true }), fc.double({ min: 0.5, max: 4, noNaN: true }), (cost, markup) => {
        const advice = priceAdvice(model, { price: cost * markup, loadedCost: cost }, features, settings);
        expect(advice).not.toBeNull();
        const a = advice!;
        for (const v of [a.current.winProbability, a.current.expectedProfit, a.best.price, a.best.winProbability, a.best.expectedProfit]) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(a.current.winProbability).toBeGreaterThan(0);
        expect(a.current.winProbability).toBeLessThan(1);
        expect(a.best.price).toBeGreaterThanOrEqual(settings.minimumJobPrice);
        // Never below the floor margin (rounding only moves the price up).
        expect((a.best.price - cost) / a.best.price).toBeGreaterThanOrEqual(settings.floorMarginPct - 1e-9);
      }),
    );
  });
});

describe('recommendationReason', () => {
  it('names the evidence behind the price', () => {
    expect(recommendationReason(model)).toBe('Expected-profit recommendation (win model, 87 quotes)');
  });
});

describe('beyondOverrideLimit', () => {
  it('mirrors the estimator approval limit in canSendQuote', () => {
    expect(beyondOverrideLimit(1100, 1000, 0.1)).toBe(false);
    expect(beyondOverrideLimit(1101, 1000, 0.1)).toBe(true);
    expect(beyondOverrideLimit(899, 1000, 0.1)).toBe(true);
    expect(beyondOverrideLimit(5000, 1000, null)).toBe(false);
    expect(beyondOverrideLimit(5000, 0, 0.1)).toBe(false);
    expect(beyondOverrideLimit(Number.NaN, 1000, 0.1)).toBe(false);
  });
});
