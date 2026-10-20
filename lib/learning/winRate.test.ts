import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WinModel } from '@/lib/pricing';
import type { WinObservation } from './types';
import { predictWin, recommendPrice, trainWinModel, winRateBuckets } from './winRate';

const NOW = new Date('2026-10-20T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

/** Deterministic PRNG (mulberry32) so synthetic data is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rand: () => number, items: Array<[T, number]>): T => {
  let u = rand();
  for (const [v, p] of items) {
    if (u < p) return v;
    u -= p;
  }
  return items[items.length - 1]![0];
};

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// The "true" market the model should recover.
const TRUE = {
  intercept: 3,
  markup: -2.5,
  log_sqft: 0.15,
  'job:walls': 0.6,
  'job:crawlspace': -0.5,
  'source:Referral': 0.9,
  'source:Yard sign': -0.6,
} as const;

const trueLogit = (markup: number, sqft: number, jobType: string, source: string | null) =>
  TRUE.intercept +
  TRUE.markup * markup +
  TRUE.log_sqft * Math.log(sqft) +
  (jobType === 'walls' ? TRUE['job:walls'] : jobType === 'crawlspace' ? TRUE['job:crawlspace'] : 0) +
  (source === 'Referral' ? TRUE['source:Referral'] : source === 'Yard sign' ? TRUE['source:Yard sign'] : 0);

function synthetic(n: number, seed: number): WinObservation[] {
  const rand = prng(seed);
  const out: WinObservation[] = [];
  for (let i = 0; i < n; i++) {
    const markup = 1.2 + rand() * 1.3;
    const sqft = 300 + rand() * 2700;
    const jobType = pick(rand, [
      ['attic', 0.5],
      ['walls', 0.3],
      ['crawlspace', 0.2],
    ]);
    const source = pick<string | null>(rand, [
      ['Google', 0.55],
      ['Referral', 0.3],
      ['Yard sign', 0.15],
    ]);
    const won = rand() < sigmoid(trueLogit(markup, sqft, jobType, source));
    out.push({ estimateId: `e${i}`, won, decidedAt: daysAgo(rand() * 30), markup, price: markup * 3000, jobType, source, sqft });
  }
  // A rare source (fewer than 5 quotes) folds into the reference level.
  for (let i = 0; i < 3; i++) {
    out.push({ estimateId: `m${i}`, won: i === 0, decidedAt: daysAgo(1), markup: 1.6, price: 4800, jobType: 'attic', source: 'Mailer', sqft: 1000 });
  }
  return out;
}

const opts = { now: NOW, halfLifeDays: 365, l2: 0, minQuotes: 40 };

const model = (weights: Record<string, number>, baseRate = 0.4): WinModel => ({
  id: 'm',
  trainedAt: NOW.toISOString(),
  nQuotes: 100,
  weights,
  jobTypes: [],
  sources: [],
  metrics: { logLoss: 0.6, auc: 0.7, baseRate },
});

describe('trainWinModel — recovers a known market from synthetic data', () => {
  const data = synthetic(6000, 42);
  const { model: m, reason } = trainWinModel(data, opts);

  it('trains and explains itself', () => {
    expect(m).not.toBeNull();
    expect(m!.nQuotes).toBe(6003);
    expect(reason).toMatch(/^Trained on 6003 decided quotes \(\d+ won\)\.$/);
  });

  it('uses the most frequent level as the reference and folds rare sources into it', () => {
    expect(m!.jobTypes).toEqual(['crawlspace', 'walls']);
    expect(m!.sources).toEqual(['Referral', 'Yard sign']);
    expect(Object.keys(m!.weights).sort()).toEqual(
      ['intercept', 'job:crawlspace', 'job:walls', 'log_sqft', 'markup', 'source:Referral', 'source:Yard sign'].sort(),
    );
  });

  it('recovers the true weights within sampling error', () => {
    const w = m!.weights;
    expect(w.markup).toBeCloseTo(TRUE.markup, 0);
    expect(Math.abs(w.markup! - TRUE.markup)).toBeLessThan(0.3);
    expect(Math.abs(w['job:walls']! - TRUE['job:walls'])).toBeLessThan(0.25);
    expect(Math.abs(w['job:crawlspace']! - TRUE['job:crawlspace'])).toBeLessThan(0.25);
    expect(Math.abs(w['source:Referral']! - TRUE['source:Referral'])).toBeLessThan(0.25);
    expect(Math.abs(w['source:Yard sign']! - TRUE['source:Yard sign'])).toBeLessThan(0.3);
    expect(Math.abs(w.log_sqft! - TRUE.log_sqft)).toBeLessThan(0.25);
  });

  it('predicts close to the true probabilities', () => {
    for (const markup of [1.3, 1.6, 2.0, 2.4]) {
      for (const [jobType, source] of [
        ['attic', 'Google'],
        ['walls', 'Referral'],
        ['crawlspace', 'Yard sign'],
      ] as const) {
        const p = predictWin(m as WinModel & typeof m, { markup, sqft: 1200, jobType, source });
        expect(Math.abs(p - sigmoid(trueLogit(markup, 1200, jobType, source)))).toBeLessThan(0.05);
      }
    }
  });

  it('scores unseen and rare levels as the reference level', () => {
    const full = { ...m!, id: 'x', trainedAt: NOW.toISOString() };
    const ref = predictWin(full, { markup: 1.6, sqft: 1000, jobType: 'attic', source: 'Google' });
    expect(predictWin(full, { markup: 1.6, sqft: 1000, jobType: 'attic', source: 'Mailer' })).toBe(ref);
    expect(predictWin(full, { markup: 1.6, sqft: 1000, jobType: 'garage', source: 'Google' })).toBe(ref);
  });

  it('reports sensible metrics', () => {
    const wins = data.filter((o) => o.won).length;
    expect(m!.metrics.baseRate).toBeGreaterThan(0);
    expect(m!.metrics.baseRate).toBeLessThan(1);
    // Every quote is recent, so the weighted base rate is close to the plain share.
    expect(Math.abs(m!.metrics.baseRate - wins / data.length)).toBeLessThan(0.02);
    expect(m!.metrics.auc).toBeGreaterThan(0.65);
    expect(m!.metrics.auc).toBeLessThanOrEqual(1);
    expect(m!.metrics.logLoss).toBeGreaterThan(0);
    expect(m!.metrics.logLoss).toBeLessThan(Math.LN2);
  });

  it('is deterministic', () => {
    expect(trainWinModel(data, opts)).toEqual(trainWinModel(data, opts));
  });
});

describe('trainWinModel — weighting, regularization and edge cases', () => {
  const mk = (won: boolean, ageDays: number, extra: Partial<WinObservation> = {}): WinObservation => ({
    estimateId: 'e',
    won,
    decidedAt: daysAgo(ageDays),
    markup: 1.7,
    price: 5100,
    jobType: 'attic',
    source: null,
    sqft: 1000,
    ...extra,
  });

  it('weights recent quotes more (recency half-life)', () => {
    // 100 old quotes, all won; 100 recent quotes, 20% won.
    const obs = [
      ...Array.from({ length: 100 }, () => mk(true, 1500)),
      ...Array.from({ length: 100 }, (_, i) => mk(i < 20, 0)),
    ];
    const short = trainWinModel(obs, { ...opts, halfLifeDays: 60 }).model!;
    expect(short.metrics.baseRate).toBeCloseTo(0.2, 3);
    const flat = trainWinModel(obs, { ...opts, halfLifeDays: 0 }).model!; // no recency weighting
    expect(flat.metrics.baseRate).toBeCloseTo(0.6, 10);
    const infinite = trainWinModel(obs, { ...opts, halfLifeDays: Infinity }).model!;
    expect(infinite.metrics.baseRate).toBeCloseTo(0.6, 10);
  });

  it('never weights a future-dated quote above a current one', () => {
    const obs = [...Array.from({ length: 30 }, () => mk(true, -400)), ...Array.from({ length: 30 }, () => mk(false, 0))];
    expect(trainWinModel(obs, { ...opts, halfLifeDays: 30 }).model!.metrics.baseRate).toBeCloseTo(0.5, 10);
  });

  it('survives data so old that raw weights underflow', () => {
    const obs = Array.from({ length: 60 }, (_, i) => mk(i % 3 === 0, 400_000 + i));
    const m = trainWinModel(obs, { ...opts, halfLifeDays: 1 }).model!;
    expect(Number.isFinite(m.metrics.baseRate)).toBe(true);
    expect(Object.values(m.weights).every(Number.isFinite)).toBe(true);
  });

  it('treats a class whose weight underflows to zero as missing', () => {
    // Losses 5,000 half-lives older than the wins: their weight is exactly 0 in floating point.
    const obs = [...Array.from({ length: 30 }, () => mk(true, 0)), ...Array.from({ length: 30 }, () => mk(false, 5000))];
    const r = trainWinModel(obs, { ...opts, halfLifeDays: 1 });
    expect(r.model).toBeNull();
    expect(r.reason).toMatch(/^Recent decided quotes were all won once older ones are down-weighted/);
    const flipped = obs.map((o) => ({ ...o, won: !o.won }));
    expect(trainWinModel(flipped, { ...opts, halfLifeDays: 1 }).reason).toMatch(/were all lost/);
  });

  it('shrinks non-intercept weights as the L2 penalty grows', () => {
    const data = synthetic(800, 7);
    const loose = trainWinModel(data, { ...opts, l2: 0 }).model!;
    const tight = trainWinModel(data, { ...opts, l2: 500 }).model!;
    expect(Math.abs(tight.weights.markup!)).toBeLessThan(Math.abs(loose.weights.markup!));
    expect(Math.abs(tight.weights['source:Referral']!)).toBeLessThan(Math.abs(loose.weights['source:Referral']!));
    // A negative or NaN penalty means no penalty.
    expect(trainWinModel(data, { ...opts, l2: -3 })).toEqual(trainWinModel(data, { ...opts, l2: 0 }));
    expect(trainWinModel(data, { ...opts, l2: NaN })).toEqual(trainWinModel(data, { ...opts, l2: 0 }));
  });

  it('cold start: fewer quotes than the minimum returns no model and a reason', () => {
    const r = trainWinModel([mk(true, 1), mk(false, 2), mk(false, 3)], opts);
    expect(r.model).toBeNull();
    expect(r.reason).toBe('Only 3 decided quotes; the win model needs at least 40. Showing win rates by bucket only.');
    expect(trainWinModel([mk(true, 1)], opts).reason).toMatch(/^Only 1 decided quote;/);
  });

  it('no data at all', () => {
    expect(trainWinModel([], opts)).toEqual({ model: null, reason: 'No decided quotes yet; showing win rates by bucket only.' });
  });

  it('a single outcome class returns no model', () => {
    const won = trainWinModel(Array.from({ length: 50 }, () => mk(true, 1)), opts);
    expect(won.model).toBeNull();
    expect(won.reason).toBe('All 50 decided quotes were won; the win model needs both wins and losses.');
    expect(trainWinModel(Array.from({ length: 50 }, () => mk(false, 1)), opts).reason).toMatch(/were lost/);
  });

  it('skips quotes with unusable data and says so', () => {
    const good = Array.from({ length: 40 }, (_, i) => mk(i % 2 === 0, i, { markup: 1.4 + (i % 5) * 0.1 }));
    const bad = [mk(true, 1, { markup: NaN }), mk(true, 1, { markup: 0 }), mk(false, 1, { sqft: NaN }), mk(true, 1, { decidedAt: 'not a date' })];
    const r = trainWinModel([...good, ...bad], opts);
    expect(r.model!.nQuotes).toBe(40);
    expect(r.reason).toContain('(4 skipped for missing data)');
    expect(trainWinModel(bad, opts).reason).toBe('No decided quotes yet (4 skipped for missing data); showing win rates by bucket only.');
    expect(trainWinModel([...good.slice(0, 10), ...bad], opts).reason).toContain('Only 10 decided quotes (4 skipped for missing data)');
  });

  it('rejects an invalid clock', () => {
    expect(() => trainWinModel([], { ...opts, now: new Date('nope') })).toThrow(RangeError);
  });

  it('stays finite on perfectly separable data without a penalty', () => {
    const obs = Array.from({ length: 60 }, (_, i) => mk(i < 30, 1, { markup: i < 30 ? 1.3 + i * 0.001 : 2.0 + i * 0.001 }));
    const r = trainWinModel(obs, { ...opts, l2: 0 });
    expect(r.model).not.toBeNull();
    expect(Object.values(r.model!.weights).every(Number.isFinite)).toBe(true);
    expect(r.model!.metrics.auc).toBe(1);
    const full = { ...r.model!, id: 'x', trainedAt: '' };
    const lo = predictWin(full, { markup: 1.3, sqft: 1000, jobType: 'attic', source: null });
    const hi = predictWin(full, { markup: 2.1, sqft: 1000, jobType: 'attic', source: null });
    expect(lo).toBeGreaterThan(0.99);
    expect(hi).toBeLessThan(0.01);
  });

  it('handles a constant feature (every job the same size and type) without blowing up', () => {
    const obs = Array.from({ length: 50 }, (_, i) => mk(i % 4 === 0, i, { markup: 1.3 + (i % 10) * 0.1 }));
    const r = trainWinModel(obs, { ...opts, l2: 0 });
    expect(r.model).not.toBeNull();
    expect(Object.values(r.model!.weights).every(Number.isFinite)).toBe(true);
    expect(r.model!.jobTypes).toEqual([]);
    expect(r.model!.sources).toEqual([]);
  });

  it('gives a frequent "Unknown" source its own weight when another source is the reference', () => {
    const obs = Array.from({ length: 60 }, (_, i) =>
      mk(i % 3 === 0, i, { source: i < 40 ? 'Google' : i < 50 ? null : '  ', markup: 1.3 + (i % 7) * 0.1 }),
    );
    expect(trainWinModel(obs, opts).model!.sources).toEqual(['Unknown']);
  });

  it('breaks frequency ties between levels alphabetically', () => {
    const obs = Array.from({ length: 40 }, (_, i) => mk(i % 2 === 0, i, { jobType: i % 2 === 0 ? 'walls' : 'attic', markup: 1.3 + (i % 9) * 0.1 }));
    expect(trainWinModel(obs, opts).model!.jobTypes).toEqual(['walls']);
  });
});

describe('predictWin', () => {
  it('is a logistic function of the weighted features', () => {
    const m = model({ intercept: 2, markup: -1.5, log_sqft: 0.1, 'job:walls': 0.3, 'source:Referral': 0.4 });
    const z = 2 - 1.5 * 1.8 + 0.1 * Math.log(1500) + 0.3 + 0.4;
    expect(predictWin(m, { markup: 1.8, sqft: 1500, jobType: 'walls', source: 'Referral' })).toBeCloseTo(sigmoid(z), 12);
  });

  it('treats tiny or missing sizes as ln(1) = 0 and a null source as Unknown', () => {
    const m = model({ intercept: 0.5, log_sqft: 1, 'source:Unknown': -0.5 });
    expect(predictWin(m, { markup: 2, sqft: 0, jobType: 'attic', source: null })).toBeCloseTo(0.5, 12);
    expect(predictWin(m, { markup: 2, sqft: NaN, jobType: 'attic', source: '' })).toBeCloseTo(0.5, 12);
  });

  it('clamps to [1e-6, 1 - 1e-6]', () => {
    expect(predictWin(model({ intercept: 1000 }), { markup: 1, sqft: 1, jobType: 'a', source: null })).toBe(1 - 1e-6);
    expect(predictWin(model({ intercept: -1000 }), { markup: 1, sqft: 1, jobType: 'a', source: null })).toBe(1e-6);
  });

  it('ignores non-finite or inherited weights and falls back to the base rate on NaN input', () => {
    const m = model({ intercept: NaN, markup: 1 }, 0.37);
    expect(predictWin(m, { markup: 0, sqft: 1, jobType: 'constructor', source: 'toString' })).toBe(0.5);
    expect(predictWin(m, { markup: NaN, sqft: 1, jobType: 'a', source: null })).toBe(0.37);
    expect(predictWin(model({ markup: 1 }, NaN), { markup: NaN, sqft: 1, jobType: 'a', source: null })).toBe(0.5);
  });

  it('is monotone non-increasing in markup when the markup weight is <= 0 (property)', () => {
    const w = fc.double({ min: -20, max: 20, noNaN: true });
    fc.assert(
      fc.property(
        fc.record({ intercept: w, markup: fc.double({ min: -20, max: 0, noNaN: true }), log_sqft: w, 'job:walls': w, 'source:Referral': w }),
        fc.double({ min: 0, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.constantFrom('attic', 'walls'),
        fc.constantFrom(null, 'Referral', 'Google'),
        (weights, a, b, sqft, jobType, source) => {
          const m = model(weights);
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const pLo = predictWin(m, { markup: lo, sqft, jobType, source });
          const pHi = predictWin(m, { markup: hi, sqft, jobType, source });
          expect(pHi).toBeLessThanOrEqual(pLo);
          expect(pLo).toBeGreaterThanOrEqual(1e-6);
          expect(pLo).toBeLessThanOrEqual(1 - 1e-6);
        },
      ),
    );
  });
});

describe('recommendPrice', () => {
  const settings = { floorMarginPct: 0.25, ceilingMarginPct: 0.6, priceRounding: 5, minimumJobPrice: 995 };
  const f = { sqft: 1000, jobType: 'attic', source: null };

  it('picks the expected-profit maximum (hand-checked against an independent scan)', () => {
    const m = model({ intercept: 30, markup: -20 });
    const r = recommendPrice(m, 1000, f, settings)!;
    // Independent oracle: same grid, same rounding, explicit sigmoid.
    let best = { price: 0, ep: -Infinity };
    for (let i = 0; i <= 70; i++) {
      const margin = 0.25 + i * 0.005;
      const price = Math.ceil(1000 / (1 - margin) / 5 - 1e-9) * 5;
      const ep = Math.round(sigmoid(30 - (20 * price) / 1000) * (price - 1000) * 100) / 100;
      if (ep > best.ep) best = { price, ep };
    }
    expect(r.price).toBe(best.price);
    expect(r.expectedProfit).toBe(best.ep);
    expect(r.price).toBe(1400); // P drops off a cliff above 1.5x; 1.4x is the sweet spot here
    for (const p of r.curve) expect(p.expectedProfit).toBeLessThanOrEqual(r.expectedProfit);
    expect(r.winProbability).toBeCloseTo(sigmoid(30 - 28), 12);
    expect(r.marginPct).toBe(Math.round((400 / 1400) * 10000) / 10000);
  });

  it('with a flat win probability, the ceiling margin maximizes expected profit', () => {
    const r = recommendPrice(model({ intercept: 0 }), 1000, f, settings)!;
    expect(r.price).toBe(2500); // 1000 / (1 - 0.6)
    expect(r.winProbability).toBe(0.5);
    expect(r.expectedProfit).toBe(750);
  });

  it('covers floor..ceiling inclusive, rounded up, ascending and deduplicated', () => {
    const r = recommendPrice(model({ intercept: 0 }), 1000, f, settings)!;
    expect(r.curve[0]!.price).toBe(1335); // 1000 / 0.75 = 1333.33 -> 1335
    expect(r.curve[r.curve.length - 1]!.price).toBe(2500);
    const prices = r.curve.map((p) => p.price);
    expect(new Set(prices).size).toBe(prices.length);
    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
    expect(prices.every((p) => p % 5 === 0)).toBe(true);
    expect(r.curve.length).toBe(71);
    for (const p of r.curve) {
      expect(p.marginPct).toBeGreaterThanOrEqual(0.25 - 1e-4);
      expect(p.marginPct).toBeLessThanOrEqual(0.6 + 1e-4);
    }
  });

  it('respects the minimum job price (equal prices collapse into one point)', () => {
    const r = recommendPrice(model({ intercept: 0 }), 300, f, settings)!;
    expect(r.curve[0]!.price).toBe(995);
    expect(r.curve.filter((p) => p.price === 995)).toHaveLength(1);
    expect(r.curve.every((p) => p.price >= 995)).toBe(true);
  });

  it('rounds to cents when rounding is off (as the engine does), and includes a ceiling off the step grid', () => {
    const r = recommendPrice(model({ intercept: 0 }), 1000, f, { ...settings, priceRounding: 0, ceilingMarginPct: 0.2512 })!;
    expect(r.curve.map((p) => p.price)).toEqual([1333.34, 1335.48]); // always rounded up to the cent
  });

  it('ties go to the lower price', () => {
    // P is clamped to 1e-6 everywhere, so every expected profit rounds to $0.00.
    const r = recommendPrice(model({ intercept: -100 }), 1000, f, settings)!;
    expect(r.expectedProfit).toBe(0);
    expect(r.price).toBe(1335);
  });

  it('never recommends below the floor, even with the ceiling configured under it', () => {
    const r = recommendPrice(model({ intercept: 0 }), 1000, f, { ...settings, ceilingMarginPct: 0.1 })!;
    expect(r.curve.map((p) => p.price)).toEqual([1335]);
  });

  it('skips margins of 100% or more', () => {
    const r = recommendPrice(model({ intercept: 0 }), 1000, f, { ...settings, floorMarginPct: 0.99, ceilingMarginPct: 1.2 })!;
    expect(r.curve.map((p) => p.price)).toEqual([100000, 200000]);
    expect(recommendPrice(model({ intercept: 0 }), 1000, f, { ...settings, floorMarginPct: 1, ceilingMarginPct: 1.2 })).toBeNull();
  });

  it('returns null without a positive loaded cost or with unusable settings', () => {
    const m = model({ intercept: 0 });
    expect(recommendPrice(m, 0, f, settings)).toBeNull();
    expect(recommendPrice(m, -5, f, settings)).toBeNull();
    expect(recommendPrice(m, NaN, f, settings)).toBeNull();
    expect(recommendPrice(m, Infinity, f, settings)).toBeNull();
    expect(recommendPrice(m, 1000, f, { ...settings, ceilingMarginPct: NaN })).toBeNull();
    expect(recommendPrice(m, 1000, f, { ...settings, minimumJobPrice: NaN })).toBeNull();
  });
});

describe('winRateBuckets', () => {
  const o = (markup: number, won: boolean, jobType = 'attic', source: string | null = 'Google'): WinObservation => ({
    estimateId: 'e',
    won,
    decidedAt: daysAgo(1),
    markup,
    price: markup * 1000,
    jobType,
    source,
    sqft: 1000,
  });

  it('always returns all five markup bands, with zero counts allowed', () => {
    const { byMarkup, byJobType, bySource } = winRateBuckets([]);
    expect(byMarkup).toEqual([
      { label: '<1.4×', quotes: 0, wins: 0, winRate: 0 },
      { label: '1.4–1.6×', quotes: 0, wins: 0, winRate: 0 },
      { label: '1.6–1.8×', quotes: 0, wins: 0, winRate: 0 },
      { label: '1.8–2.0×', quotes: 0, wins: 0, winRate: 0 },
      { label: '2.0×+', quotes: 0, wins: 0, winRate: 0 },
    ]);
    expect(byJobType).toEqual([]);
    expect(bySource).toEqual([]);
  });

  it('puts band edges in the upper band', () => {
    const obs = [o(1.39, true), o(1.4, false), o(1.59, true), o(1.6, true), o(1.8, false), o(1.99, true), o(2.0, true), o(3.5, false)];
    const counts = winRateBuckets(obs).byMarkup.map((b) => [b.quotes, b.wins]);
    expect(counts).toEqual([
      [1, 1],
      [2, 1],
      [1, 1],
      [2, 1],
      [2, 1],
    ]);
    expect(winRateBuckets(obs).byMarkup[1]!.winRate).toBe(0.5);
  });

  it('groups by job type and source (null or blank -> Unknown), most quotes first, ties alphabetical', () => {
    const obs = [o(1.5, true, 'walls', null), o(1.5, false, 'attic', 'Referral'), o(1.5, true, 'attic', 'Referral'), o(NaN, false, 'garage', '')];
    const r = winRateBuckets(obs);
    expect(r.byJobType).toEqual([
      { label: 'attic', quotes: 2, wins: 1, winRate: 0.5 },
      { label: 'garage', quotes: 1, wins: 0, winRate: 0 },
      { label: 'walls', quotes: 1, wins: 1, winRate: 1 },
    ]);
    expect(r.bySource).toEqual([
      { label: 'Referral', quotes: 2, wins: 1, winRate: 0.5 },
      { label: 'Unknown', quotes: 2, wins: 1, winRate: 0.5 },
    ]);
    // A quote without a usable markup still counts by job type and source, but in no band.
    expect(r.byMarkup.reduce((a, b) => a + b.quotes, 0)).toBe(3);
  });
});
