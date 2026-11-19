import { describe, expect, it } from 'vitest';
import { coeff, findCoefficient } from './coefficients';
import { allocate, ceilHalf, money, monthlyPayment, roundUpTo } from './finance';
import { canSendQuote, estimatorRange, floorPrice, type PriceApproval } from './policy';
import { priceEstimate } from './engine';
import { PricingConfigError, type CoefficientSet, type PricedOption } from './types';
import { coefficients, estimate, snapshot } from './__fixtures__/seed';

describe('findCoefficient', () => {
  const set: CoefficientSet = {
    id: 's',
    version: 1,
    coefficients: [
      { kind: 'labor_hrs_per_unit', product: null, jobType: null, accessLevel: null, value: 1 },
      { kind: 'labor_hrs_per_unit', product: 'cellulose', jobType: null, accessLevel: null, value: 2 },
      { kind: 'labor_hrs_per_unit', product: 'cellulose', jobType: 'attic', accessLevel: null, value: 3 },
      { kind: 'labor_hrs_per_unit', product: 'ocsf', jobType: 'attic', accessLevel: null, value: 4 },
      { kind: 'waste_factor', product: 'cellulose', jobType: null, accessLevel: null, value: 0 },
    ],
  };

  it('prefers the most specific match', () => {
    expect(findCoefficient(set, 'labor_hrs_per_unit', { product: 'cellulose', jobType: 'attic' })?.value).toBe(3);
    expect(findCoefficient(set, 'labor_hrs_per_unit', { product: 'cellulose', jobType: 'walls' })?.value).toBe(2);
    expect(findCoefficient(set, 'labor_hrs_per_unit', { product: 'batts', jobType: 'attic' })?.value).toBe(1);
  });

  it('never matches a coefficient scoped to a different value', () => {
    expect(findCoefficient(set, 'labor_hrs_per_unit', { product: 'ccsf' })?.value).toBe(1);
  });

  it('returns null when nothing matches', () => {
    expect(findCoefficient(set, 'drive_time_factor', {})).toBeNull();
  });

  it('coeff throws on missing or invalid values', () => {
    expect(() => coeff(set, 'drive_time_factor', {})).toThrow(PricingConfigError);
    expect(() => coeff(set, 'waste_factor', { product: 'cellulose' })).toThrow(/invalid value/);
    expect(() => coeff(set, 'setup_hours', { product: 'ocsf', jobType: 'attic', accessLevel: 'easy' })).toThrow(/ocsf\/attic\/easy/);
  });
});

describe('finance helpers', () => {
  it('money rounds to cents', () => {
    expect(money(1.005)).toBe(1.01);
    expect(money(2.344)).toBe(2.34);
  });

  it('roundUpTo rounds up and tolerates float noise', () => {
    expect(roundUpTo(5415.33, 5)).toBe(5420);
    expect(roundUpTo(5420.0000000001, 5)).toBe(5420);
    expect(roundUpTo(12.345, 0)).toBe(12.35);
    expect(roundUpTo(12.341, 0)).toBe(12.35); // never rounds down, even without a $ step
    expect(roundUpTo(12.34, 0)).toBe(12.34);
  });

  it('monthlyPayment matches the amortization formula', () => {
    expect(monthlyPayment(10000, 0, 100)).toBe(100);
    expect(monthlyPayment(0, 0.1, 12)).toBe(0);
    expect(monthlyPayment(10000, 0.12, 12)).toBeCloseTo(888.49, 2);
    expect(() => monthlyPayment(100, 0.1, 0)).toThrow(RangeError);
  });

  it('ceilHalf rounds up to half units', () => {
    expect(ceilHalf(0.2)).toBe(0.5);
    expect(ceilHalf(1)).toBe(1);
    expect(ceilHalf(1.01)).toBe(1.5);
  });

  it('allocate splits exactly in cents', () => {
    expect(allocate(100, [1, 1, 1])).toEqual([33.34, 33.33, 33.33]);
    expect(allocate(10, [0, 0])).toEqual([5, 5]);
    expect(allocate(0.03, [0, 0])).toEqual([0.02, 0.01]);
    expect(allocate(5, [])).toEqual([]);
    expect(allocate(99.99, [3, -1, 7]).reduce((a, b) => a + b, 0)).toBeCloseTo(99.99, 10);
  });
});

describe('canSendQuote', () => {
  const opts = (input = estimate()) => priceEstimate(input, snapshot, coefficients).options;
  const override = (price: number, reason = 'reason') => opts(estimate({ overrides: { good: { price, reason } } }));

  it('allows a model-priced quote for any staff role', () => {
    for (const role of ['owner', 'office', 'estimator'] as const) {
      expect(canSendQuote(role, opts(), snapshot.settings).ok).toBe(true);
    }
  });

  it('blocks crew', () => {
    expect(canSendQuote('crew', opts(), snapshot.settings).ok).toBe(false);
  });

  it('lets an estimator move the price within the limit but not beyond it', () => {
    expect(canSendQuote('estimator', override(5420 * 0.95), snapshot.settings).ok).toBe(true);
    const r = canSendQuote('estimator', override(5420 * 0.85), snapshot.settings);
    expect(r.ok).toBe(false);
    expect(r.reasons[0]).toMatch(/estimators may change it up to 10%/);
    expect(canSendQuote('office', override(5420 * 0.85), snapshot.settings).ok).toBe(true);
  });

  it('only the owner may go below the floor margin', () => {
    const low = override(3500);
    expect(canSendQuote('office', low, snapshot.settings).ok).toBe(false);
    expect(canSendQuote('owner', low, snapshot.settings).ok).toBe(true);
  });

  it('requires a reason for any override', () => {
    const r = canSendQuote('owner', override(5300, '  '), snapshot.settings);
    expect(r.reasons).toContain('good: a price override needs a reason.');
  });

  it('handles a zero model price without dividing by zero', () => {
    const o = { ...opts()[0]!, isOverridden: true, modelPrice: 0, overrideReason: 'x' } satisfies PricedOption;
    expect(canSendQuote('estimator', [o], snapshot.settings).ok).toBe(true);
  });
});

describe('price policy: what an estimator may quote alone, and approvals (L34)', () => {
  const opts = (input = estimate()) => priceEstimate(input, snapshot, coefficients, { showAll: true }).options;
  const override = (price: number, reason = 'Neighbour discount') => opts(estimate({ overrides: { good: { price, reason } } }));
  const approval = (over: Partial<PriceApproval> = {}): PriceApproval => ({
    id: 'a1',
    estimateId: 'e1',
    tier: 'good',
    price: 4500,
    modelPrice: 5420,
    belowFloor: false,
    status: 'approved',
    decidedRole: 'office',
    ...over,
  });

  it('the lowest price the floor margin allows, and the range an estimator may quote alone', () => {
    const good = opts()[0]!;
    // Good: loaded cost $3,249.20 at a 25% floor -> $4,332.27, so $4,333 in whole dollars.
    expect(floorPrice(good, snapshot.settings)).toBe(4333);
    expect((4333 - good.loadedCost) / 4333).toBeGreaterThanOrEqual(snapshot.settings.floorMarginPct);
    expect((4332 - good.loadedCost) / 4332).toBeLessThan(snapshot.settings.floorMarginPct);
    // Model $5,420, 10% either way: $4,878 to $5,962, never under the floor.
    expect(estimatorRange(good, snapshot.settings)).toEqual({ min: 4878, max: 5962 });
    expect(estimatorRange({ ...good, modelPrice: 4400 }, snapshot.settings)).toEqual({ min: 4333, max: 4840 });
    expect(estimatorRange({ ...good, modelPrice: 0 }, snapshot.settings)).toBeNull();
  });

  it('names the price, the model price and the range the estimator may quote alone', () => {
    const r = canSendQuote('estimator', override(4500), snapshot.settings);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      {
        tier: 'good',
        kind: 'over_limit',
        price: 4500,
        modelPrice: 5420,
        range: { min: 4878, max: 5962 },
        floor: 4333,
        approver: 'office',
        message: 'Good: $4,500 is 17% below the model price of $5,420. You can quote $4,878 to $5,962 on your own (estimators may change it up to 10%). Request approval to send $4,500.',
      },
    ]);
    expect(r.reasons).toEqual([r.problems[0]!.message]);
    const up = canSendQuote('estimator', override(6200), snapshot.settings).problems[0]!;
    expect(up.message).toBe('Good: $6,200 is 14% above the model price of $5,420. You can quote $4,878 to $5,962 on your own (estimators may change it up to 10%). Request approval to send $6,200.');
  });

  it('below the floor margin: the lowest price it allows, and only the owner can approve', () => {
    const est = canSendQuote('estimator', override(3500), snapshot.settings).problems;
    expect(est).toHaveLength(1);
    expect(est[0]).toMatchObject({ tier: 'good', kind: 'below_floor', price: 3500, modelPrice: 5420, floor: 4333, approver: 'owner' });
    expect(est[0]!.message).toBe(
      'Good: $3,500 is below the 25% floor margin; the lowest price it allows is $4,333 (model price $5,420). You can quote $4,878 to $5,962 on your own (estimators may change it up to 10%). Only the owner can approve $3,500.',
    );
    const office = canSendQuote('office', override(3500), snapshot.settings).problems;
    expect(office[0]!.message).toBe('Good: $3,500 is below the 25% floor margin; the lowest price it allows is $4,333 (model price $5,420). Only the owner can approve $3,500.');
    expect(office[0]!.range).toBeUndefined();
  });

  it('an approved price can be sent: that option, that exact price, that model price', () => {
    const options = override(4500);
    expect(canSendQuote('estimator', options, snapshot.settings, [approval()]).ok).toBe(true);
    expect(canSendQuote('estimator', options, snapshot.settings, [approval({ decidedRole: 'owner' })]).ok).toBe(true);
    for (const other of [
      approval({ status: 'pending', decidedRole: null }),
      approval({ status: 'declined' }),
      approval({ price: 4501 }),
      approval({ tier: 'better' }),
      approval({ modelPrice: 5425 }),
      approval({ decidedRole: 'estimator' }),
    ]) {
      expect(canSendQuote('estimator', options, snapshot.settings, [other]).ok).toBe(false);
    }
  });

  it('below the floor margin only an approval the owner gave counts', () => {
    const options = override(3500);
    expect(canSendQuote('estimator', options, snapshot.settings, [approval({ price: 3500, belowFloor: true, decidedRole: 'office' })]).ok).toBe(false);
    expect(canSendQuote('office', options, snapshot.settings, [approval({ price: 3500, belowFloor: true, decidedRole: 'office' })]).ok).toBe(false);
    expect(canSendQuote('estimator', options, snapshot.settings, [approval({ price: 3500, belowFloor: true, decidedRole: 'owner' })]).ok).toBe(true);
    expect(canSendQuote('office', options, snapshot.settings, [approval({ price: 3500, belowFloor: true, decidedRole: 'owner' })]).ok).toBe(true);
  });

  it('an approval never stands in for the reason a price change needs', () => {
    const r = canSendQuote('estimator', override(4500, '  '), snapshot.settings, [approval()]);
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['good: a price override needs a reason.']);
    expect(r.problems[0]).toMatchObject({ tier: 'good', kind: 'no_reason' });
  });
});
