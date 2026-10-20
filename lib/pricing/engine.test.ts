import { describe, expect, it } from 'vitest';
import { priceEstimate, validateSnapshot } from './engine';
import { PricingConfigError, type PricedOption, type PricingSnapshot } from './types';
import { area, coefficients, estimate, snapshot } from './__fixtures__/seed';

const tier = (opts: PricedOption[], t: PricedOption['tier']) => {
  const o = opts.find((x) => x.tier === t);
  if (!o) throw new Error(`no ${t} option`);
  return o;
};

const withSettings = (patch: Partial<PricingSnapshot['settings']>): PricingSnapshot => ({
  ...snapshot,
  settings: { ...snapshot.settings, ...patch },
});

describe('priceEstimate — hand-checked attic example', () => {
  // 1,000 sq ft open attic, easy access, R-0 -> code R-60, 20 min drive, Crew A (2 people @ $40/h).
  const result = priceEstimate(estimate(), snapshot, coefficients);
  const good = tier(result.options, 'good');

  it('offers good, better and best', () => {
    expect(result.options.map((o) => o.tier)).toEqual(['good', 'better', 'best']);
    expect(result.crewId).toBe('crew-a');
  });

  it('computes blown fiberglass quantity from R-value, coverage and waste', () => {
    // 60 / 2.5 = 24 in; 1000 * 24 / 450 = 53.33 bags; * 1.08 = 57.6 -> 58 whole bags
    const mat = good.lines.find((l) => l.kind === 'material')!;
    expect(mat.designQty).toBeCloseTo(53.33, 2);
    expect(mat.qty).toBe(58);
    expect(mat.cost).toBe(2204);
  });

  it('computes labor from setup + units x rate x access', () => {
    // 2 + 53.33 * 0.15 * 1.0 = 10.0 person-hours, $400
    const labor = good.lines.find((l) => l.kind === 'labor')!;
    expect(labor.hours).toBe(10);
    expect(labor.cost).toBe(400);
    expect(good.crewDays).toBe(1); // 10 / (2 * 7) = 0.71 -> 1.0 (half-day rounding)
  });

  it('computes drive cost from minutes, trips, crew size and the drive factor', () => {
    // 20 min * 2 ways * 1 trip * 2 people * 1.1 / 60 = 1.4667 h * $40 = 58.67 + $45 rig
    expect(good.driveCost).toBe(103.67);
  });

  it('loads overhead and prices to target margin, rounding up to $5', () => {
    expect(good.directCost).toBe(2707.67);
    expect(good.loadedCost).toBe(3249.2); // * 1.20
    expect(good.modelPrice).toBe(5420); // 3249.20 / 0.60 = 5415.33 -> 5420
    expect(good.price).toBe(5420);
    expect(good.marginPct).toBeGreaterThanOrEqual(0.4);
    expect(good.belowFloor).toBe(false);
  });

  it('allocates the price to customer items so they sum exactly', () => {
    const total = good.customerItems.reduce((a, b) => a + b.price, 0);
    expect(Math.round(total * 100)).toBe(Math.round(good.price * 100));
    expect(good.customerItems[0]!.description).toContain('R-60');
  });

  it('adds a financing line', () => {
    expect(good.financing).not.toBeNull();
    expect(good.financing!.monthly).toBe(Math.ceil((5420 * (0.0999 / 12)) / (1 - Math.pow(1 + 0.0999 / 12, -120))));
  });

  it('better adds air sealing; best adds removal only when there is something to remove', () => {
    const better = tier(result.options, 'better');
    expect(better.lines.some((l) => l.product === 'air_sealing')).toBe(true);
    const best = tier(result.options, 'best');
    expect(best.lines.some((l) => l.kind === 'removal')).toBe(false); // R-0, nothing to remove
  });
});

describe('priceEstimate — scope rules', () => {
  it('only adds the R-value that is missing when existing insulation stays', () => {
    const r = priceEstimate(estimate({ areas: [area({ currentR: 30 })] }), snapshot, coefficients);
    const mat = tier(r.options, 'good').lines.find((l) => l.kind === 'material')!;
    // added R 30 -> 12 in -> 26.67 bags -> * 1.08 = 28.8 -> 29
    expect(mat.qty).toBe(29);
  });

  it('removal resets existing R to zero and adds removal labor + disposal', () => {
    const r = priceEstimate(
      estimate({ areas: [area({ currentR: 30, removalNeeded: true, existingMaterial: 'fiberglass' })] }),
      snapshot,
      coefficients,
    );
    const good = tier(r.options, 'good');
    const removal = good.lines.find((l) => l.kind === 'removal')!;
    expect(removal.hours).toBe(21); // setup 1 + 1000 * 0.02 * 1.0
    expect(good.disposalCost).toBe(350);
    expect(good.lines.find((l) => l.kind === 'material')!.qty).toBe(58); // full R-60
  });

  it('best tier includes removal when old insulation exists', () => {
    const r = priceEstimate(estimate({ areas: [area({ currentR: 19 })] }), snapshot, coefficients);
    expect(tier(r.options, 'best').lines.some((l) => l.kind === 'removal')).toBe(true);
    expect(tier(r.options, 'good').lines.some((l) => l.kind === 'removal')).toBe(false);
  });

  it('uses the job-type removal rate, falling back to the global rate', () => {
    const r = priceEstimate(
      estimate({ areas: [area({ jobType: 'garage', currentR: 11, removalNeeded: true })] }),
      snapshot,
      coefficients,
    );
    expect(tier(r.options, 'good').lines.find((l) => l.kind === 'removal')!.hours).toBe(26); // 1 + 1000*0.025
  });

  it('skips the product and warns when already at target', () => {
    const r = priceEstimate(estimate({ areas: [area({ currentR: 60 })] }), snapshot, coefficients);
    expect(r.options.find((o) => o.tier === 'good')).toBeUndefined();
    expect(r.warnings.some((w) => w.code === 'already_at_target')).toBe(true);
    expect(r.warnings.some((w) => w.code === 'tier_skipped' && w.tier === 'good')).toBe(true);
    // better still has air sealing work to do
    expect(tier(r.options, 'better').lines.every((l) => l.product !== 'cellulose')).toBe(true);
  });

  it('caps thickness at cavity depth and reports the achieved R', () => {
    // 2x4 wall, open-cell: R-20 needs 5.4 in; only 3.5 fits -> R-13
    const r = priceEstimate(
      estimate({ areas: [area({ jobType: 'walls', depthIn: 3.5, sqft: 500 })] }),
      snapshot,
      coefficients,
    );
    const better = tier(r.options, 'better');
    expect(better.lines.find((l) => l.kind === 'material')!.designQty).toBe(1750); // 500 * 3.5
    expect(better.customerItems[0]!.description).toContain('R-13');
    expect(r.warnings.some((w) => w.code === 'thickness_capped' && w.tier === 'better')).toBe(true);
  });

  it('prices batts per square foot regardless of R', () => {
    const r = priceEstimate(estimate({ areas: [area({ jobType: 'crawlspace', sqft: 800 })] }), snapshot, coefficients);
    const mat = tier(r.options, 'good').lines.find((l) => l.kind === 'material')!;
    expect(mat.qty).toBe(840); // 800 * 1.05
    expect(mat.unit).toBe('sqft');
  });

  it('an estimator target R overrides tier defaults', () => {
    const r = priceEstimate(estimate({ areas: [area({ targetR: 38 })] }), snapshot, coefficients);
    expect(tier(r.options, 'good').customerItems[0]!.description).toContain('R-38');
  });

  it('applies the access multiplier to labor', () => {
    const easy = priceEstimate(estimate(), snapshot, coefficients);
    const hard = priceEstimate(estimate({ areas: [area({ accessLevel: 'difficult' })] }), snapshot, coefficients);
    const h = (o: PricedOption) => o.lines.find((l) => l.kind === 'labor')!.hours!;
    expect(h(tier(hard.options, 'good'))).toBeCloseTo(2 + 8 * 1.35, 2);
    expect(h(tier(easy.options, 'good'))).toBe(10);
  });

  it('enforces the minimum job price', () => {
    const r = priceEstimate(
      estimate({ areas: [area({ jobType: 'rim_joist', sqft: 20 })], driveMinutesOneWay: 0 }),
      snapshot,
      coefficients,
    );
    expect(tier(r.options, 'good').price).toBe(995);
  });

  it('labels multi-area options as packages and bundles all areas', () => {
    const r = priceEstimate(
      estimate({ areas: [area(), area({ id: 'a2', name: 'Crawl', jobType: 'crawlspace', sqft: 600 })] }),
      snapshot,
      coefficients,
    );
    const good = tier(r.options, 'good');
    expect(good.label).toBe('Good package');
    expect(new Set(good.customerItems.map((i) => i.areaId))).toEqual(new Set(['a1', 'a2']));
  });

  it('uses the chosen crew and rounds crew days to half days', () => {
    const r = priceEstimate(estimate({ crewId: 'crew-b', areas: [area({ sqft: 3000 })] }), snapshot, coefficients);
    const good = tier(r.options, 'good');
    expect(r.crewId).toBe('crew-b');
    expect(good.crewDays * 2).toBe(Math.round(good.crewDays * 2));
  });

  it('falls back to the default crew for an unknown crew id', () => {
    expect(priceEstimate(estimate({ crewId: 'nope' }), snapshot, coefficients).crewId).toBe('crew-a');
  });

  it('skips a tier with no template for a job type and warns', () => {
    const s = { ...snapshot, tierTemplates: snapshot.tierTemplates.filter((t) => !(t.jobType === 'attic' && t.tier === 'best')) };
    const r = priceEstimate(estimate(), s, coefficients);
    expect(r.options.map((o) => o.tier)).toEqual(['good', 'better']);
    expect(r.warnings.some((w) => w.code === 'no_template')).toBe(true);
  });

  it('hides financing when turned off', () => {
    const s = withSettings({ financing: { ...snapshot.settings.financing, show: false } });
    expect(tier(priceEstimate(estimate(), s, coefficients).options, 'good').financing).toBeNull();
  });

  it('supports an air-sealing-only template', () => {
    const s = {
      ...snapshot,
      tierTemplates: snapshot.tierTemplates.map((t) =>
        t.jobType === 'attic' && t.tier === 'good' ? { ...t, primaryProduct: 'air_sealing' as const } : t,
      ),
    };
    const good = tier(priceEstimate(estimate(), s, coefficients).options, 'good');
    expect(good.lines.filter((l) => l.areaId).every((l) => l.product === 'air_sealing')).toBe(true);
  });

  it('air sealing works without a material row (labor only)', () => {
    const s = { ...snapshot, materials: snapshot.materials.filter((m) => m.productCode !== 'air_sealing') };
    const better = tier(priceEstimate(estimate(), s, coefficients).options, 'better');
    const air = better.lines.filter((l) => l.product === 'air_sealing');
    expect(air.map((l) => l.kind)).toEqual(['labor']);
  });
});

describe('priceEstimate — tier order', () => {
  it('warns when a lower tier costs more than a higher one', () => {
    const pricey = { ...snapshot, materials: snapshot.materials.map((m) => (m.productCode === 'fiberglass_blown' ? { ...m, costPerUnit: 200 } : m)) };
    const r = priceEstimate(estimate(), pricey, coefficients);
    expect(r.warnings.some((w) => w.code === 'tier_price_order' && w.tier === 'better')).toBe(true);
    const cheap = { ...snapshot, materials: snapshot.materials.map((m) => (m.productCode === 'fiberglass_blown' ? { ...m, costPerUnit: 5 } : m)) };
    expect(priceEstimate(estimate(), cheap, coefficients).warnings.some((w) => w.code === 'tier_price_order')).toBe(false);
  });
});

describe('priceEstimate — overrides', () => {
  it('applies a price override and recomputes margin', () => {
    const r = priceEstimate(estimate({ overrides: { good: { price: 5000, reason: 'match competitor' } } }), snapshot, coefficients);
    const good = tier(r.options, 'good');
    expect(good.price).toBe(5000);
    expect(good.modelPrice).toBe(5420);
    expect(good.isOverridden).toBe(true);
    expect(good.overrideReason).toBe('match competitor');
    expect(good.marginPct).toBeCloseTo((5000 - 3249.2) / 5000, 4);
  });

  it('flags an override below the floor margin', () => {
    const r = priceEstimate(estimate({ overrides: { good: { price: 3500, reason: 'x' } } }), snapshot, coefficients);
    expect(tier(r.options, 'good').belowFloor).toBe(true);
    expect(r.warnings.some((w) => w.code === 'override_below_floor')).toBe(true);
  });

  it('ignores a non-positive override', () => {
    const r = priceEstimate(estimate({ overrides: { good: { price: 0, reason: 'x' } } }), snapshot, coefficients);
    expect(tier(r.options, 'good').isOverridden).toBe(false);
  });
});

describe('configuration and input validation', () => {
  const bad: Array<[string, PricingSnapshot]> = [
    ['margin >= 0.95', withSettings({ targetMarginPct: 0.95 })],
    ['floor above target', withSettings({ floorMarginPct: 0.5 })],
    ['negative overhead', withSettings({ overheadPct: -0.1 })],
    ['negative minimum', withSettings({ minimumJobPrice: -1 })],
    ['negative rounding', withSettings({ priceRounding: -5 })],
    ['zero hours/day', withSettings({ productiveHoursPerDay: 0 })],
    ['negative vehicle', withSettings({ vehicleCostPerTrip: -1 })],
    ['negative disposal', withSettings({ disposalCostPerSqft: -1 })],
    ['bad financing', withSettings({ financing: { provider: null, apr: 1.5, termMonths: 120, show: true } })],
    ['no crews', { ...snapshot, crews: [] }],
    ['bad crew', { ...snapshot, crews: [{ id: 'x', name: 'x', size: 0, blendedHourlyCost: 40 }] }],
    ['negative material', { ...snapshot, materials: [{ ...snapshot.materials[0]!, costPerUnit: -1 }] }],
    ['bag without coverage', { ...snapshot, materials: [{ ...snapshot.materials[2]!, coverageSqftIn: null }] }],
  ];
  it.each(bad)('rejects %s', (_name, s) => {
    expect(() => validateSnapshot(s)).toThrow(PricingConfigError);
  });

  it('accepts the seed snapshot', () => {
    expect(() => validateSnapshot(snapshot)).not.toThrow();
  });

  it('throws a config error for a missing coefficient', () => {
    const k = { ...coefficients, coefficients: coefficients.coefficients.filter((c) => c.kind !== 'drive_time_factor') };
    expect(() => priceEstimate(estimate(), snapshot, k)).toThrow(/drive_time_factor/);
  });

  it('throws a config error for a missing product, material, or code minimum', () => {
    expect(() => priceEstimate(estimate(), { ...snapshot, products: snapshot.products.filter((p) => p.code !== 'cellulose') }, coefficients)).toThrow(PricingConfigError);
    expect(() => priceEstimate(estimate(), { ...snapshot, materials: snapshot.materials.filter((m) => m.productCode !== 'cellulose') }, coefficients)).toThrow(/no default material/);
    expect(() => priceEstimate(estimate(), { ...snapshot, codeRequirements: [] }, coefficients)).toThrow(/code minimum/);
  });

  it('throws when a primary product has no R per inch or is not insulation', () => {
    const noRpi = { ...snapshot, products: snapshot.products.map((p) => (p.code === 'cellulose' ? { ...p, rPerInch: null } : p)) };
    expect(() => priceEstimate(estimate(), noRpi, coefficients)).toThrow(/R per inch/);
    const notR = { ...snapshot, products: snapshot.products.map((p) => (p.code === 'cellulose' ? { ...p, isRBearing: false } : p)) };
    expect(() => priceEstimate(estimate(), notR, coefficients)).toThrow(/primary insulation/);
  });

  it('removal as a primary product adds no insulation', () => {
    const s = {
      ...snapshot,
      tierTemplates: snapshot.tierTemplates.map((t) => (t.jobType === 'attic' && t.tier === 'good' ? { ...t, primaryProduct: 'removal' as const } : t)),
    };
    const r = priceEstimate(estimate({ areas: [area({ currentR: 19, removalNeeded: true })] }), s, coefficients);
    expect(tier(r.options, 'good').lines.some((l) => l.kind === 'material')).toBe(false);
  });

  it.each([
    ['zero sqft', { sqft: 0 }],
    ['NaN sqft', { sqft: Number.NaN }],
    ['negative R', { currentR: -1 }],
    ['zero target', { targetR: 0 }],
    ['zero depth', { depthIn: 0 }],
  ])('rejects %s', (_n, patch) => {
    expect(() => priceEstimate(estimate({ areas: [area(patch)] }), snapshot, coefficients)).toThrow(RangeError);
  });
});
