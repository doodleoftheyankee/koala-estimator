import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_LEVELS,
  lineKey,
  priceEstimate,
  type CoefficientSet,
  type EstimateInput,
  type LineOverride,
  type PricedEstimate,
  type PricingSnapshot,
} from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { computeDeviationFlags, deviationOutcome } from './deviation';

const bundle = { snapshot, coefficientSet: coefficients };

const run = (input: EstimateInput, b: { snapshot: PricingSnapshot; coefficientSet: CoefficientSet } = bundle) =>
  computeDeviationFlags(priceEstimate(input, b.snapshot, b.coefficientSet), input, b);

const withLines = (lineOverrides: Record<string, LineOverride>, base: Partial<EstimateInput> = {}) =>
  estimate({ ...base, lineOverrides });

const FG_LABOR = lineKey('a1', 'fiberglass_blown', 'labor'); // good tier, model 10 h
const FG_MAT = lineKey('a1', 'fiberglass_blown', 'material'); // good tier, model 58 bags (53.33 before waste)
const CEL_LABOR = lineKey('a1', 'cellulose', 'labor'); // better + best, model 14.5 h
const LOW = 'The model has little data here, so your judgement may well be better — explain it.';
const PRIOR = 'starting estimate, no job data yet';

/** The seed coefficients with evidence attached to one cell. */
const withEvidence = (
  match: (c: CoefficientSet['coefficients'][number]) => boolean,
  evidence: { sampleSize?: number; confidence?: number },
): CoefficientSet => ({
  ...coefficients,
  coefficients: coefficients.coefficients.map((c) => (match(c) ? { ...c, ...evidence } : c)),
});
const fgRate = (c: CoefficientSet['coefficients'][number]) => c.kind === 'labor_hrs_per_unit' && c.product === 'fiberglass_blown';

describe('computeDeviationFlags — no deviation, no flag', () => {
  it('raises nothing without overrides', () => {
    expect(run(estimate())).toEqual([]);
    expect(run(estimate({ areas: [area({ removalNeeded: true }), area({ id: 'a2', name: 'Walls', jobType: 'walls' })] }))).toEqual([]);
  });

  it('raises nothing for an override equal to the model value', () => {
    expect(run(withLines({ [FG_LABOR]: { hours: 10, reason: 'same' }, [FG_MAT]: { qty: 58, reason: 'same' } }))).toEqual([]);
  });
});

describe('computeDeviationFlags — threshold (strictly greater than settings.deviationThreshold)', () => {
  const hoursFlags = (hours: number) => run(withLines({ [FG_LABOR]: { hours, reason: 'r' } })).filter((f) => f.metric === 'hours');

  it('exactly 15% is not flagged; 15.1% is', () => {
    expect(hoursFlags(11.5)).toEqual([]);
    expect(hoursFlags(8.5)).toEqual([]);
    expect(hoursFlags(11.51)).toHaveLength(1);
    expect(hoursFlags(8.49)).toHaveLength(1);
  });

  it('ignores floating-point noise at the threshold', () => {
    // (66.7 - 58) / 58 = 0.15000000000000005 in floating point.
    expect(run(withLines({ [FG_MAT]: { qty: 66.7, reason: 'r' } }))).toEqual([]);
    expect(run(withLines({ [FG_MAT]: { qty: 66.8, reason: 'r' } }))).toHaveLength(1);
  });

  it('uses the configured threshold', () => {
    const loose = { snapshot: { ...snapshot, settings: { ...snapshot.settings, deviationThreshold: 0.6 } }, coefficientSet: coefficients };
    expect(run(withLines({ [FG_LABOR]: { hours: 15, reason: 'r' } }), loose)).toEqual([]);
    expect(run(withLines({ [FG_LABOR]: { hours: 16.1, reason: 'r' } }), loose)).toHaveLength(1);
  });

  it('flags any change when the threshold is misconfigured, rather than none', () => {
    for (const deviationThreshold of [NaN, -0.2]) {
      const broken = { snapshot: { ...snapshot, settings: { ...snapshot.settings, deviationThreshold } }, coefficientSet: coefficients };
      // 5% more hours: the line and (with a threshold of 0) the total it moves are both flagged.
      expect(run(withLines({ [FG_LABOR]: { hours: 10.5, reason: 'r' } }), broken).map((f) => f.key)).toEqual([`${FG_LABOR}|hours`, 'good|total_price']);
    }
  });
});

describe('computeDeviationFlags — line flags', () => {
  it('labor hours: key, values, message and reasons', () => {
    const [flag, ...rest] = run(withLines({ [FG_LABOR]: { hours: 15, reason: 'Steep roof' } }));
    expect(rest.every((f) => f.metric === 'total_price')).toBe(true);
    expect(flag).toEqual({
      key: 'a1|fiberglass_blown|labor|hours',
      tier: 'good',
      lineKey: 'a1|fiberglass_blown|labor',
      metric: 'hours',
      estimatorValue: 15,
      modelValue: 10,
      pctDiff: 0.5,
      message: 'Labor hours 50% above model for Main attic (Blown Fiberglass): you entered 15 h, the model predicts 10 h.',
      reasons: [
        { code: 'labor_rate', text: `Labor rate 0.15 h per bag for blown fiberglass in attics (${PRIOR}).` },
        { code: 'access', text: `Access multiplier ×1 for easy access (${PRIOR}).` },
        { code: 'setup', text: `Setup 2 h per area for blown fiberglass (${PRIOR}).` },
        { code: 'low_confidence', text: LOW },
      ],
    });
  });

  it('material quantity: waste factor, implied waste and design quantity', () => {
    const [flag] = run(withLines({ [FG_MAT]: { qty: 45, reason: 'Leftover bags on site' } }));
    expect(flag).toMatchObject({
      key: 'a1|fiberglass_blown|material|qty',
      tier: 'good',
      metric: 'qty',
      estimatorValue: 45,
      modelValue: 58,
      pctDiff: -0.2241,
      message: 'Material quantity 22% below model for Main attic (Blown Fiberglass): you entered 45 bags, the model predicts 58 bags.',
    });
    expect(flag!.reasons).toEqual([
      { code: 'waste', text: `Waste factor 1.08 for blown fiberglass in attics (${PRIOR}); your quantity implies 0.844.` },
      { code: 'design_qty', text: 'Design quantity before waste: 53.3 bags.' },
      { code: 'low_confidence', text: LOW },
    ]);
  });

  it('removal hours use the removal rate, access and removal setup', () => {
    const input = withLines({ [lineKey('a1', 'removal', 'removal')]: { hours: 40, reason: 'Wet, matted insulation' } }, {
      areas: [area({ removalNeeded: true, accessLevel: 'difficult' })],
    });
    const flags = run(input).filter((f) => f.metric === 'hours');
    expect(flags).toHaveLength(1); // the removal line is in every tier; flagged once
    expect(flags[0]).toMatchObject({
      key: 'a1|removal|removal|hours',
      tier: 'good',
      estimatorValue: 40,
      modelValue: 28,
      pctDiff: 0.4286,
      message: 'Removal hours 43% above model for Main attic (Old Insulation Removal): you entered 40 h, the model predicts 28 h.',
    });
    expect(flags[0]!.reasons.map((r) => r.text)).toEqual([
      `Removal rate 0.02 h per sq ft in attics (${PRIOR}).`,
      `Access multiplier ×1.35 for difficult access (${PRIOR}).`,
      `Setup 1 h per area for old insulation removal (${PRIOR}).`,
      LOW,
    ]);
  });

  it('names the design unit of each product in the labor rate', () => {
    const rateText = (input: EstimateInput) => run(input).find((f) => f.metric === 'hours')!.reasons[0]!.text;
    const air = lineKey('a1', 'air_sealing', 'labor');
    expect(rateText(withLines({ [air]: { hours: 20, reason: 'r' } }))).toBe(`Labor rate 0.006 h per sq ft for air sealing in attics (${PRIOR}).`);
    const ocsf = lineKey('w1', 'ocsf', 'labor');
    const walls = { areas: [area({ id: 'w1', name: 'Walls', jobType: 'walls' as const })] };
    expect(rateText(withLines({ [ocsf]: { hours: 40, reason: 'r' } }, walls))).toBe(`Labor rate 0.004 h per board ft for open-cell spray foam in walls (${PRIOR}).`);
    const batts = lineKey('c1', 'batts', 'labor');
    const crawl = { areas: [area({ id: 'c1', name: 'Crawl', jobType: 'crawlspace' as const })] };
    expect(rateText(withLines({ [batts]: { hours: 40, reason: 'r' } }, crawl))).toBe(`Labor rate 0.015 h per sq ft for fiberglass batts in crawlspaces (${PRIOR}).`);
  });

  it('cites sample size and confidence when the coefficient has them, and drops low_confidence when well supported', () => {
    const strong = { snapshot, coefficientSet: withEvidence(fgRate, { sampleSize: 27, confidence: 81.4 }) };
    const [flag] = run(withLines({ [FG_LABOR]: { hours: 14, reason: 'r' } }), strong);
    expect(flag!.reasons[0]).toEqual({ code: 'labor_rate', text: 'Labor rate 0.15 h per bag for blown fiberglass in attics (based on 27 jobs, confidence 81).' });
    expect(flag!.reasons.map((r) => r.code)).toEqual(['labor_rate', 'access', 'setup']);

    const one = { snapshot, coefficientSet: withEvidence(fgRate, { sampleSize: 1 }) };
    expect(run(withLines({ [FG_LABOR]: { hours: 14, reason: 'r' } }), one)[0]!.reasons[0]!.text).toContain('(based on 1 job).');
  });

  it('adds low_confidence when confidence < 50 or fewer than 5 jobs', () => {
    const codes = (evidence: { sampleSize?: number; confidence?: number }) =>
      run(withLines({ [FG_LABOR]: { hours: 14, reason: 'r' } }), { snapshot, coefficientSet: withEvidence(fgRate, evidence) })[0]!.reasons.map((r) => r.code);
    expect(codes({ sampleSize: 27, confidence: 49 })).toContain('low_confidence');
    expect(codes({ sampleSize: 4, confidence: 90 })).toContain('low_confidence');
    expect(codes({ sampleSize: 5, confidence: 50 })).not.toContain('low_confidence');
  });

  it('explains a quantity for a product without a waste factor', () => {
    const [flag] = run(withLines({ [lineKey('a1', 'air_sealing', 'material')]: { qty: 1500, reason: 'Lots of penetrations' } }));
    expect(flag!.message).toBe('Material quantity 50% above model for Main attic (Air Sealing): you entered 1,500 sq ft, the model predicts 1,000 sq ft.');
    expect(flag!.tier).toBe('better');
    expect(flag!.reasons).toEqual([
      { code: 'waste', text: 'No waste factor is set for air sealing, so the model uses the design quantity; your quantity implies 1.5.' },
      { code: 'design_qty', text: 'Design quantity before waste: 1,000 sq ft.' },
      { code: 'low_confidence', text: LOW },
    ]);
  });

  it('deduplicates the same line across tiers, keeping the first tier', () => {
    const flags = run(withLines({ [CEL_LABOR]: { hours: 30, reason: 'r' } }));
    const line = flags.filter((f) => f.lineKey === CEL_LABOR);
    expect(line).toHaveLength(1);
    expect(line[0]!.tier).toBe('better');
    expect(new Set(flags.map((f) => f.key)).size).toBe(flags.length);
  });

  it('flags a line in the first tier where it actually deviates', () => {
    // Existing R-30: better tops it up (8.25 h); best removes it and installs R-60 (14.5 h).
    const input = withLines({ [CEL_LABOR]: { hours: 9, reason: 'r' } }, { areas: [area({ currentR: 30, existingMaterial: 'fiberglass' })] });
    const line = run(input).filter((f) => f.lineKey === CEL_LABOR);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatchObject({ tier: 'best', modelValue: 14.5, estimatorValue: 9, pctDiff: -0.3793 });
  });

  it('copes with an area missing from the input and a product missing from the snapshot', () => {
    const input = withLines({ [FG_LABOR]: { hours: 15, reason: 'r' } });
    const priced = priceEstimate(input, snapshot, coefficients);
    const noProducts = { snapshot: { ...snapshot, products: snapshot.products.filter((p) => p.code !== 'fiberglass_blown') }, coefficientSet: coefficients };
    const [flag] = computeDeviationFlags(priced, { ...input, areas: [] }, noProducts);
    expect(flag!.message).toBe('Labor hours 50% above model for this area (fiberglass_blown): you entered 15 h, the model predicts 10 h.');
    expect(flag!.reasons.map((r) => r.text)).toEqual([
      `Labor rate 0.15 h per bag for fiberglass_blown (${PRIOR}).`,
      `Setup 2 h per area for fiberglass_blown (${PRIOR}).`,
      LOW,
    ]);
  });

  it('keeps pctDiff within what the database column holds', () => {
    const [flag] = run(withLines({ [FG_MAT]: { qty: 1_000_000, reason: 'typo' } }));
    expect(flag!.pctDiff).toBe(9999);
    expect(flag!.message).toBe('Material quantity 1,724,038% above model for Main attic (Blown Fiberglass): you entered 1,000,000 bags, the model predicts 58 bags.');
  });

  it('skips lines it cannot compare', () => {
    const base = priceEstimate(estimate(), snapshot, coefficients);
    const good = base.options[0]!;
    const mutate = (patch: Partial<(typeof good.lines)[number]>, index: number): PricedEstimate => ({
      ...base,
      options: [{ ...good, lines: good.lines.map((l, i) => (i === index ? { ...l, ...patch, isOverridden: true } : l)) }],
    });
    const mat = good.lines.findIndex((l) => l.kind === 'material');
    const labor = good.lines.findIndex((l) => l.kind === 'labor');
    const drive = good.lines.findIndex((l) => l.kind === 'drive');
    for (const priced of [
      mutate({ qty: 100, modelQty: 0 }, mat), // no model value to compare against
      mutate({ qty: 100, modelQty: null }, mat),
      mutate({ hours: 30, modelHours: -1 }, labor),
      mutate({ hours: null }, labor),
      mutate({ hours: NaN }, labor),
      mutate({ qty: 100, key: null }, mat), // job-level lines have no stable key
      mutate({ qty: 100, product: null }, mat),
      mutate({ qty: 10, hours: 10 }, drive), // drive and disposal are not estimator lines
    ]) {
      expect(computeDeviationFlags(priced, estimate(), bundle)).toEqual([]);
    }
  });

  it('explains sparse lines without inventing numbers', () => {
    const base = priceEstimate(estimate(), snapshot, coefficients);
    const good = base.options[0]!;
    const priced: PricedEstimate = {
      ...base,
      options: [
        {
          ...good,
          lines: good.lines.map((l) =>
            l.kind === 'material' ? { ...l, qty: 80, designQty: null, unit: null, areaId: null, isOverridden: true } : l,
          ),
        },
      ],
    };
    const [flag] = computeDeviationFlags(priced, estimate(), bundle);
    expect(flag!.message).toBe('Material quantity 38% above model for this area (Blown Fiberglass): you entered 80, the model predicts 58.');
    expect(flag!.reasons).toEqual([
      { code: 'waste', text: `Waste factor 1.08 for blown fiberglass (${PRIOR}).` },
      { code: 'low_confidence', text: LOW },
    ]);
  });

  it('still warns of low confidence when the driving coefficient is missing or has no job count', () => {
    const priced = priceEstimate(withLines({ [FG_LABOR]: { hours: 15, reason: 'r' } }), snapshot, coefficients);
    const noRate = { snapshot, coefficientSet: { ...coefficients, coefficients: coefficients.coefficients.filter((c) => !fgRate(c)) } };
    expect(computeDeviationFlags(priced, estimate(), noRate)[0]!.reasons.map((r) => r.code)).toEqual(['access', 'setup', 'low_confidence']);
    const noCount = { snapshot, coefficientSet: withEvidence(fgRate, { confidence: 90 }) };
    expect(computeDeviationFlags(priced, estimate(), noCount)[0]!.reasons.map((r) => r.code)).toContain('low_confidence');
  });

  it('is deterministic (keys are stable across syncs)', () => {
    const input = withLines({ [FG_LABOR]: { hours: 15, reason: 'r' }, [CEL_LABOR]: { hours: 30, reason: 'r' } });
    expect(run(input)).toEqual(run(input));
  });
});

describe('computeDeviationFlags — total price flags', () => {
  it('flags a price override beyond the threshold with its reason', () => {
    const flags = run(estimate({ overrides: { good: { price: 4336, reason: 'Neighbor discount' } } }));
    expect(flags).toEqual([
      {
        key: 'good|total_price',
        tier: 'good',
        lineKey: null,
        metric: 'total_price',
        estimatorValue: 4336,
        modelValue: 5420,
        pctDiff: -0.2,
        reasons: [{ code: 'price_override', text: 'Price set by hand: Neighbor discount.' }],
        message: 'Good option price 20% below model: you are quoting $4,336, the model price is $5,420.',
      },
    ]);
  });

  it('does not flag a price override of exactly the threshold', () => {
    expect(run(estimate({ overrides: { good: { price: 6233, reason: 'r' } } }))).toEqual([]);
  });

  it('formats cents and a missing reason', () => {
    const [flag] = run(estimate({ overrides: { better: { price: 5560.5, reason: '  ' } } }));
    expect(flag!.message).toBe('Better option price 15.5% above model: you are quoting $5,560.50, the model price is $4,815.');
    expect(flag!.reasons).toEqual([{ code: 'price_override', text: 'Price set by hand: no reason given.' }]);
  });

  it('flags line overrides that move the total, naming the lines', () => {
    const input = withLines({ [FG_MAT]: { qty: 120, reason: 'Deep cavities' }, [FG_LABOR]: { hours: 25, reason: 'Slow blow' } });
    const flags = run(input);
    expect(flags.map((f) => f.key)).toEqual(['a1|fiberglass_blown|material|qty', 'a1|fiberglass_blown|labor|hours', 'good|total_price']);
    const good = priceEstimate(input, snapshot, coefficients).options[0]!;
    const total = flags[2]!;
    expect(total.estimatorValue).toBe(good.price);
    expect(total.modelValue).toBe(5420);
    expect(total.reasons).toEqual([
      {
        code: 'line_overrides',
        text: `Your changes to 2 lines (Blown fiberglass bag, Install blown fiberglass) move the price to $${good.adjustedPrice.toLocaleString('en-US')}.`,
      },
    ]);
  });

  it('gives both reasons when a price override sits on top of line overrides', () => {
    const input = withLines({ [FG_LABOR]: { hours: 12, reason: 'r' } }, { overrides: { good: { price: 7000, reason: 'Rush job' } } });
    const total = run(input).find((f) => f.key === 'good|total_price')!;
    expect(total.reasons.map((r) => r.code)).toEqual(['price_override', 'line_overrides']);
    expect(total.reasons[1]!.text).toMatch(/^Your changes to 1 line \(Install blown fiberglass\) move the price to \$/);
  });

  it('skips options without a model price', () => {
    const priced = priceEstimate(estimate({ overrides: { good: { price: 100, reason: 'r' } } }), snapshot, coefficients);
    const zero = { ...priced, options: priced.options.map((o) => ({ ...o, modelPrice: 0 })) };
    expect(computeDeviationFlags(zero, estimate(), bundle)).toEqual([]);
  });
});

describe('computeDeviationFlags — invariants (property-based)', () => {
  const areaArb = fc.record({
    jobType: fc.constantFrom('attic', 'walls', 'crawlspace', 'rim_joist', 'garage', 'commercial' as const),
    sqft: fc.integer({ min: 50, max: 5000 }),
    currentR: fc.constantFrom(0, 11, 30),
    accessLevel: fc.constantFrom(...ACCESS_LEVELS),
    removalNeeded: fc.boolean(),
  });

  it('every line flag is a real deviation above the threshold, and every such deviation is flagged once', () => {
    fc.assert(
      fc.property(areaArb, fc.double({ min: 0, max: 3, noNaN: true }), fc.nat(), (a, factor, pick) => {
        const base = estimate({ areas: [area({ ...a, existingMaterial: a.currentR > 0 ? 'old' : null })] });
        const lines = priceEstimate(base, snapshot, coefficients).options.flatMap((o) => o.lines).filter((l) => l.key);
        if (lines.length === 0) return; // already at target R in every tier: nothing to override
        const target = lines[pick % lines.length]!;
        const ov: LineOverride =
          target.kind === 'material' ? { qty: target.modelQty! * factor, reason: 'r' } : { hours: target.modelHours! * factor, reason: 'r' };
        const input = { ...base, lineOverrides: { [target.key!]: ov } };
        const priced = priceEstimate(input, snapshot, coefficients);
        const flags = computeDeviationFlags(priced, input, bundle);
        const t = snapshot.settings.deviationThreshold;

        expect(new Set(flags.map((f) => f.key)).size).toBe(flags.length);
        for (const f of flags) {
          expect(Math.abs(f.estimatorValue - f.modelValue) / f.modelValue).toBeGreaterThan(t);
          expect(f.message.length).toBeGreaterThan(0);
          if (f.metric !== 'total_price') expect(f.reasons.length).toBeGreaterThan(0);
        }
        for (const o of priced.options) {
          for (const l of o.lines.filter((x) => x.isOverridden)) {
            const [est, model] = l.kind === 'material' ? [l.qty, l.modelQty!] : [l.hours!, l.modelHours!];
            const metric = l.kind === 'material' ? 'qty' : 'hours';
            if (model > 0 && Math.abs(est - model) / model > t + 1e-9) {
              expect(flags.some((f) => f.key === `${l.key}|${metric}`)).toBe(true);
            }
          }
        }
      }),
    );
  });
});

describe('deviationOutcome', () => {
  it('names whoever was closer to the actual value', () => {
    expect(deviationOutcome(14, 10, 13.5)).toBe('estimator_closer');
    expect(deviationOutcome(14, 10, 10.4)).toBe('model_closer');
    expect(deviationOutcome(50, 60, 0)).toBe('estimator_closer');
  });

  it('is a tie when the errors are within 2% of the actual value', () => {
    expect(deviationOutcome(11, 9, 10)).toBe('tie'); // equal errors
    expect(deviationOutcome(10.2, 10, 10)).toBe('tie'); // 0.2 = 2% of 10
    expect(deviationOutcome(10.21, 10, 10)).toBe('model_closer');
    expect(deviationOutcome(-10, 10, -10)).toBe('estimator_closer');
    expect(deviationOutcome(0, 0, 0)).toBe('tie'); // both exact
    expect(deviationOutcome(5, 5, 0)).toBe('tie'); // both equally wrong
  });

  it('is a tie when any value is not a number', () => {
    expect(deviationOutcome(NaN, 10, 10)).toBe('tie');
    expect(deviationOutcome(10, Infinity, 10)).toBe('tie');
    expect(deviationOutcome(10, 9, NaN)).toBe('tie');
  });
});
