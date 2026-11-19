// The accuracy checks themselves: the seeded pricing fixture they price with, and each rule
// (lib/pricing/invariants.ts, lib/quotes/invariants.ts) on hand-made good and bad quotes.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMoney } from '@/lib/format';
import {
  ACCESS_LEVELS,
  JOB_TYPES,
  priceEstimate,
  type AreaInput,
  type CustomerItem,
  type EstimateInput,
  type PricedEstimate,
  type PricedLine,
  type PricedOption,
  type Tier,
} from '@/lib/pricing';
import { mulberry32, randomQuotes } from '@/lib/pricing/__fixtures__/random';
import { bundleFromRows, seededBundle, seededRows } from '@/lib/pricing/__fixtures__/seeded';
import {
  addedThickness,
  cavityDepth,
  checkCavityNotOverfilled,
  checkFiniteAmounts,
  checkItemsAddUp,
  checkLabelsMatchWork,
  checkOptionsStepUp,
  checkPricedQuote,
  checkSameWorkSamePrice,
  dollarsText,
  existingRPerInch,
  existingThickness,
  finalR,
  INVARIANT_IDS,
  printedDollars,
  shownOptions,
  workScope,
  type Violation,
} from '@/lib/pricing/invariants';
import {
  checkSamePriceText,
  checkValidUntilIsExpiry,
  compareReadings,
  expectedHeadline,
  headlineTexts,
  linkExpiresAt,
  PRICE_SURFACES,
  priceTexts,
  SURFACE_IDS,
} from '@/lib/quotes/invariants';
import type { QuoteDocument } from '@/lib/quotes/model';
import { quoteSettingsFromRows } from '@/lib/quotes/settings';
import { parseSettings } from '@/lib/server/snapshot';
import { areaSchema } from '@/lib/sync/draft';
import { diffRows, PRICING_SETTING_KEYS, stableId, stableRows } from './rows';

const root = path.resolve(import.meta.dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

const area = (o: Partial<AreaInput> = {}): AreaInput => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Attic',
  jobType: 'attic',
  sqft: 1000,
  currentR: 0,
  targetR: null,
  existingMaterial: null,
  existingDepthIn: null,
  depthIn: null,
  accessLevel: 'easy',
  removalNeeded: false,
  prepNotes: null,
  ...o,
});
const estimate = (areas: AreaInput[], o: Partial<EstimateInput> = {}): EstimateInput => ({
  areas,
  crewId: null,
  driveMinutesOneWay: 20,
  overrides: {},
  ...o,
});
const priceSeeded = (input: EstimateInput) => priceEstimate(input, seededBundle.snapshot, seededBundle.coefficientSet);

describe('seeded pricing fixture (the rows every migration leaves in a new database)', () => {
  it('is a valid pricing setup that keeps only the pricing settings', () => {
    expect(seededRows.settings.map((s) => s.key).sort()).toEqual([...PRICING_SETTING_KEYS].sort());
    expect(() => parseSettings(seededRows.settings)).not.toThrow();
    expect(JSON.stringify(seededRows)).not.toMatch(/branding|Newark|Delaware|\(302\)/);
    expect(seededBundle.snapshot.defaultCrewId).toBe(seededRows.crews[0]!.id);
    // A fixed build time: the bundle and its hash are the same on every run.
    expect(bundleFromRows(seededRows).hash).toBe(seededBundle.hash);
  });

  it('bundle-rows.sql reads the same rows as loadPricingBundle, and only the pricing settings', () => {
    const sql = read('scripts/accuracy/bundle-rows.sql');
    const keys = /where key in \(([^)]*)\)/.exec(sql)![1]!.match(/'([a-z_]+)'/g)!.map((k) => k.slice(1, -1));
    expect(keys.sort()).toEqual([...PRICING_SETTING_KEYS].sort());
    for (const filter of ['from products where active', 'where m.active and m.is_default', 'from crews where active', 'from code_requirements where is_default', 'from tier_templates where active', "where status = 'active'", 'from win_models where is_active']) {
      expect(sql).toContain(filter);
    }
    const loader = read('lib/server/bundle.ts');
    for (const filter of [".from('products')", ".eq('active', true)", ".eq('is_default', true)", ".eq('status', 'active')", ".eq('is_active', true)"]) {
      expect(loader).toContain(filter);
    }
  });

  it('prices the examples in the round 1 record exactly as the record says (drive 20 min, seeded pricing)', () => {
    // L1: attic 1,200 sq ft at R-19 with removal.
    const l1 = priceSeeded(estimate([area({ sqft: 1200, currentR: 19, removalNeeded: true })]));
    expect(l1.options.map((o) => o.price)).toEqual([6385, 8010, 8010]);
    expect(l1.options[0]!.customerItems[0]!.price).toBe(2720.15);
    expect(l1.options[1]!.customerItems[0]!.price).toBe(2735.84);
    // L18: walls 1,000 sq ft, no depth: Better $3,580.
    expect(priceSeeded(estimate([area({ jobType: 'walls', name: 'Walls' })])).options[1]!.price).toBe(3580);
    // L14: attic 1,200 sq ft at R-0: Best $5,160, the same as Better.
    expect(priceSeeded(estimate([area({ sqft: 1200 })])).options.map((o) => o.price)).toEqual([3720, 5160, 5160]);
    // L19: walls 1,000 sq ft 2x4 full of R-11 batts: $1,500 / $1,740 / $2,505.
    const l19 = priceSeeded(estimate([area({ jobType: 'walls', depthIn: 3.5, currentR: 11, existingMaterial: 'Fiberglass batts' })]));
    expect(l19.options.map((o) => o.price)).toEqual([1500, 1740, 2505]);
    // L22: crawlspace 800 sq ft 2x6, target R-38: Good batts $2,270.
    expect(priceSeeded(estimate([area({ jobType: 'crawlspace', sqft: 800, depthIn: 5.5, targetR: 38 })])).options[0]!.price).toBe(2270);
  });

  it('gives every row an id made from what it is, so two databases compare row for row', () => {
    expect(stableId('crew:Crew A')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(stableRows(seededRows)).toEqual(seededRows);
    // The same rows with other ids (another database) are the same rows.
    const crew = seededRows.crews[0]!;
    const other = structuredClone(seededRows);
    other.crews[0]!.id = '11111111-1111-4111-8111-111111111111';
    other.settings = other.settings.map((s) => (s.key === 'default_crew_id' ? { ...s, value: other.crews[0]!.id } : s));
    other.products = other.products.map((p, i) => ({ ...p, id: `p${i}` }));
    other.materials = other.materials.map((m) => ({ ...m, product_id: `p${seededRows.products.findIndex((p) => p.id === m.product_id)}` }));
    other.coefficientSet = { ...other.coefficientSet, id: 'another-set' };
    expect(stableRows(other)).toEqual(seededRows);
    // PostgREST and psql print numerics differently ("0.7500" or 0.75); a comparison ignores that.
    other.materials = other.materials.map((m) => ({ ...m, cost_per_unit: Number(m.cost_per_unit).toFixed(4) }));
    expect(diffRows(other, seededRows)).toEqual([]);
    // A changed value is a difference.
    other.crews[0]!.blended_hourly_cost = Number(crew.blended_hourly_cost) + 1;
    expect(diffRows(other, seededRows)).toEqual([
      expect.stringContaining('crews: only in the first'),
      expect.stringContaining('crews: only in the second'),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hand-made quotes: the rules are tested on quotes built here, not on what the engine does today,
// so these tests keep passing while the engine is fixed.
// ---------------------------------------------------------------------------

const A1 = '00000000-0000-4000-8000-0000000000a1';
const A2 = '00000000-0000-4000-8000-0000000000a2';
const snap = seededBundle.snapshot;
const coeffs = seededBundle.coefficientSet;
const mat = (code: string) => snap.materials.find((m) => m.productCode === code)!;

function line(o: Partial<PricedLine> & Pick<PricedLine, 'kind'>): PricedLine {
  return {
    key: null,
    areaId: A1,
    product: null,
    materialId: null,
    description: 'line',
    qty: 1,
    unit: 'each',
    hours: null,
    unitCost: null,
    cost: 100,
    designQty: null,
    modelQty: null,
    modelHours: null,
    modelCost: 100,
    isOverridden: false,
    overrideReason: null,
    ...o,
  };
}

/** A material line installing `qty` units of a product's default material in area A1. */
function insulation(code: 'cellulose' | 'ocsf' | 'ccsf' | 'batts' | 'fiberglass_blown', qty: number, areaId = A1): PricedLine {
  const m = mat(code);
  return line({ kind: 'material', areaId, product: code, materialId: m.id, unit: m.unit, qty, modelQty: qty, description: m.name });
}

function item(description: string, price: number, areaId: string | null = A1, kind?: string): CustomerItem {
  return { areaId, areaName: areaId ? 'Attic' : '', description, price, ...(kind ? { kind } : {}) } as CustomerItem;
}

function option(tier: Tier, price: number, o: Partial<PricedOption> = {}): PricedOption {
  return {
    tier,
    label: `${tier} option`,
    bullets: [],
    lines: [],
    customerItems: [item(`${tier} work`, price)],
    materialCost: 0,
    laborHours: 0,
    laborCost: 0,
    driveCost: 0,
    disposalCost: 0,
    directCost: 0,
    loadedCost: 0,
    modelPrice: price,
    adjustedPrice: price,
    price,
    isOverridden: false,
    hasLineOverrides: false,
    overrideReason: null,
    marginPct: 0.15,
    belowFloor: false,
    crewDays: 1,
    financing: null,
    ...o,
  };
}

const quote = (options: PricedOption[], areas: AreaInput[] = [area({ id: A1 })]) => ({
  input: estimate(areas),
  priced: { options, warnings: [], crewId: 'crew' } as PricedEstimate,
  snapshot: snap,
  coefficients: coeffs,
});
const kinds = (vs: Violation[]) => vs.map((v) => `${v.invariant}:${v.kind}:${v.tier}`);

describe('helpers: what the customer reads and what is in the wall', () => {
  it('printedDollars and dollarsText read amounts the way the whole-dollar formatters print them', () => {
    for (const n of [0, 0.49, 0.5, 4321.5, 4321.49, 4321.51, 999.995, 14994.5, 1e6 + 0.5, 1.005, 2.675]) {
      expect(dollarsText(n)).toBe(formatMoney(Math.round(n * 100) / 100, { cents: 'never' }));
    }
    expect(printedDollars(4321.5)).toBe(4322);
    expect(dollarsText(-95.4)).toBe('-$95');
  });

  it('shownOptions is what the customer is shown: every option, except one marked hidden', () => {
    const shown = shownOptions({ options: [option('good', 1), { ...option('better', 2), hidden: true } as PricedOption], warnings: [], crewId: 'c' });
    expect(shown.map((o) => o.tier)).toEqual(['good']);
  });

  it('a wall with no depth is a 2x4 wall (OD5); other areas have a cavity only when a depth is entered', () => {
    expect(cavityDepth({ jobType: 'walls', depthIn: null })).toBe(3.5);
    expect(cavityDepth({ jobType: 'walls', depthIn: 5.5 })).toBe(5.5);
    expect(cavityDepth({ jobType: 'attic', depthIn: null })).toBeNull();
    expect(cavityDepth({ jobType: 'crawlspace', depthIn: 7.25 })).toBe(7.25);
  });

  it('existing insulation takes room: its depth, else its R over its R per inch (names in any case), none once removed', () => {
    const walls = area({ jobType: 'walls', currentR: 11, existingMaterial: 'fiberglass BATTS' });
    expect(existingThickness(walls)).toBeCloseTo(11 / 3.2, 6);
    expect(existingThickness({ ...walls, existingDepthIn: 2 })).toBe(2);
    // An unknown material is read at the highest R per inch, so its room is never overstated.
    expect(existingRPerInch('mystery fill')).toBe(3.7);
    expect(existingRPerInch(null)).toBe(3.7);
    const removed = option('good', 1, { lines: [line({ kind: 'removal', areaId: A1 })] });
    expect(existingThickness(walls, removed)).toBe(0);
  });

  it('added thickness comes from the quantity priced, the waste taken out; finalR adds what stays', () => {
    const walls = area({ jobType: 'walls', sqft: 1000, currentR: 5, existingMaterial: 'Cellulose' });
    // 1,000 sq ft x 3.5 in / 200 sq ft·in per bag = 17.5 bags installed; x 1.08 waste = 18.9 priced.
    const o = option('good', 1, { lines: [insulation('cellulose', 18.9)] });
    expect(addedThickness(o, walls, snap, coeffs)).toBeCloseTo(3.5, 6);
    expect(finalR(o, walls, snap, coeffs)).toBeCloseTo(5 + 3.5 * 3.6, 6);
    // Board feet: 1,000 sq ft x 2 in = 2,000 bd ft installed, x 1.25 waste = 2,500 priced.
    expect(addedThickness(option('better', 1, { lines: [insulation('ocsf', 2500)] }), walls, snap, coeffs)).toBeCloseTo(2, 6);
    // Batts are as thick as the R they state (over R per inch), above what stays.
    const batts = option('good', 1, { lines: [insulation('batts', 1000)], customerItems: [item('Fiberglass Batts, R-21, 1,000 sq ft', 1)] });
    expect(addedThickness(batts, walls, snap, coeffs)).toBeCloseTo((21 - 5) / 3.2, 6);
    expect(finalR(batts, walls, snap, coeffs)).toBeCloseTo(21, 6);
  });
});

describe('helpers: reading a line without the coefficient set', () => {
  it('takes the waste from the line (its own waste factor, else model over design quantity)', () => {
    const walls = area({ jobType: 'walls', sqft: 1000 });
    const own = { ...insulation('cellulose', 18.9), wasteFactor: 1.08 } as PricedLine;
    expect(addedThickness(option('good', 1, { lines: [own] }), walls, snap)).toBeCloseTo(3.5, 6);
    const ratio = { ...insulation('cellulose', 18.9), designQty: 17.5, modelQty: 18.9 };
    expect(addedThickness(option('good', 1, { lines: [ratio] }), walls, snap)).toBeCloseTo(3.5, 6);
    expect(addedThickness(option('good', 1, { lines: [{ ...insulation('cellulose', 17.5), modelQty: null }] }), walls, snap)).toBeCloseTo(3.5, 6);
  });
  it('names the scope of a work item for the report', () => {
    expect(workScope('Remove and dispose of existing insulation (1,200 sq ft)')).toBe('removal');
    expect(workScope('Air sealing of top plates, penetrations and bypasses (1,200 sq ft)')).toBe('air_sealing');
    expect(workScope('Blown Cellulose to R-49 (~13.6" added), 1,200 sq ft')).toBe('insulation');
  });
});

describe('items_add_up (S1-F2): printed items add up to the printed total', () => {
  it('passes when the printed items add up, also with a negative price adjustment line', () => {
    const o = option('better', 3000, { customerItems: [item('Attic work', 2153), item('Travel and setup', 942, null, 'travel'), item('Price adjustment', -95, null, 'adjustment')] });
    expect(checkItemsAddUp(quote([o]))).toEqual([]);
  });
  it('fails when the printed items are a dollar off the printed total (the PDF with $14,994 under $14,995)', () => {
    const o = option('better', 14995, { customerItems: [item('Garage', 1889.4, A1), item('Garage 2', 6482.4, A2), item('Crawlspace', 6623.2, A1)] });
    expect(kinds(checkItemsAddUp(quote([o])))).toEqual(['items_add_up:printed:better']);
  });
  it('fails to the cent when the items do not sum to the price', () => {
    const o = option('good', 1000, { customerItems: [item('Work', 999.99)] });
    expect(kinds(checkItemsAddUp(quote([o])))).toEqual(['items_add_up:cents:good']);
  });
});

describe('same_work_same_price (S1-F3, OD2): the same work costs the same in every option', () => {
  const removal = 'Remove and dispose of existing insulation (1,200 sq ft)';
  it('fails when the same removal is $2,720 in Good and $2,736 in Better', () => {
    const v = checkSameWorkSamePrice(quote([option('good', 6385, { customerItems: [item(removal, 2720.15), item('Cellulose', 3664.85)] }), option('better', 8010, { customerItems: [item(removal, 2735.84), item('Cellulose to R-60', 5274.16)] })]));
    expect(kinds(v)).toEqual(['same_work_same_price:removal:better']);
    expect(v[0]!.areaId).toBe(A1);
  });
  it('passes when shared work has one price; travel lines and different work may differ', () => {
    const v = checkSameWorkSamePrice(
      quote([
        option('good', 3040, { customerItems: [item(removal, 2483), item('Cellulose to R-49', 0), item('Travel and setup', 557, null, 'travel')] }),
        option('better', 5000, { customerItems: [item(removal, 2483), item('Cellulose to R-60', 2000), item('Travel and setup', 517, null, 'travel')] }),
      ]),
    );
    expect(v).toEqual([]);
  });
});

describe('options_step_up (S1-F7, OD6): the options shown step up', () => {
  const work = (tier: Tier, price: number, description: string) => option(tier, price, { customerItems: [item(description, price)] });
  it('passes when each option does more and costs more', () => {
    expect(checkOptionsStepUp(quote([work('good', 1500, 'Batts'), work('better', 2000, 'Open-cell'), work('best', 3000, 'Closed-cell')]))).toEqual([]);
  });
  it('fails when Best repeats Better, when an option does not cost more, and says when an estimator changed a price', () => {
    expect(kinds(checkOptionsStepUp(quote([work('good', 3720, 'Cellulose to R-49'), work('better', 5160, 'Cellulose to R-60'), work('best', 5160, 'Cellulose to R-60')])))).toEqual([
      'options_step_up:duplicate_shown:best',
    ]);
    expect(kinds(checkOptionsStepUp(quote([work('good', 1500, 'Batts'), work('better', 1500, 'Open-cell')])))).toEqual(['options_step_up:not_increasing:better']);
    const overridden = { ...work('good', 6000, 'Batts'), isOverridden: true };
    expect(kinds(checkOptionsStepUp(quote([overridden, work('better', 3955, 'Open-cell')])))).toEqual(['options_step_up:not_increasing_override:better']);
  });
  it('checks only what is shown: a hidden duplicate is not a violation', () => {
    const hidden = { ...work('best', 5160, 'Cellulose to R-60'), hidden: true } as PricedOption;
    expect(checkOptionsStepUp(quote([work('good', 3720, 'Cellulose to R-49'), work('better', 5160, 'Cellulose to R-60'), hidden]))).toEqual([]);
  });
});

describe('labels_match_work (S1-F7): titles and bullets promise only work that is priced', () => {
  const attic = area({ id: A1, sqft: 1000, currentR: 11, existingMaterial: 'Fiberglass batts' });
  // Cellulose from R-11 to R-30: 19 / 3.6 in over 1,000 sq ft, at 200 sq ft·in per bag, x 1.08.
  const toR = (r: number) => ((((r - 11) / 3.6) * 1000) / 200) * 1.08;
  it('"to Code" below the code minimum fails; reaching code passes', () => {
    const below = option('good', 1, { label: 'Blown Cellulose to Code', lines: [insulation('cellulose', toR(30))] });
    expect(kinds(checkLabelsMatchWork(quote([below], [attic])))).toEqual(['labels_match_work:code_below_code:good']);
    const atCode = option('good', 1, { label: 'Blown Cellulose to Code', lines: [insulation('cellulose', toR(49))] });
    expect(checkLabelsMatchWork(quote([atCode], [attic]))).toEqual([]);
  });
  it('a bullet about the attic is checked against the attic only', () => {
    const walls = area({ id: A2, jobType: 'walls', name: 'Walls', currentR: 0 });
    const o = option('good', 1, { label: 'Good package', bullets: ['Brings your attic to current code R-value'], lines: [insulation('cellulose', toR(49))] });
    expect(checkLabelsMatchWork(quote([o], [attic, walls]))).toEqual([]);
  });
  it('"Remove…" with no removal priced fails; with removal it passes', () => {
    const noRemoval = option('best', 1, { label: 'Remove, Air Seal + Cellulose', lines: [insulation('cellulose', toR(60)), line({ kind: 'material', product: 'air_sealing' })] });
    expect(kinds(checkLabelsMatchWork(quote([noRemoval], [attic])))).toEqual(['labels_match_work:removal_not_priced:best']);
    const withRemoval = { ...noRemoval, lines: [...noRemoval.lines, line({ kind: 'removal', product: 'removal' })] };
    expect(checkLabelsMatchWork(quote([withRemoval], [{ ...attic, currentR: 0 }]))).toEqual([]);
  });
  it('an air-sealing promise needs air sealing priced, or spray foam (which seals as it insulates)', () => {
    const none = option('better', 1, { bullets: ['Full air sealing before new insulation'], lines: [insulation('cellulose', toR(60))] });
    expect(kinds(checkLabelsMatchWork(quote([none], [attic])))).toEqual(['labels_match_work:air_sealing:better']);
    const foam = option('better', 1, { bullets: ['Air seal and insulate in one step'], lines: [insulation('ocsf', 3000)] });
    expect(checkLabelsMatchWork(quote([foam], [attic]))).toEqual([]);
  });
});

describe('cavity_not_overfilled (S1-F4, S1-F5, S1-F6, OD5): insulation fits the cavity', () => {
  it('a wall with no depth is a 2x4: 5.4 in of open-cell does not fit (overfilled_no_depth)', () => {
    const walls = area({ jobType: 'walls', sqft: 1000 });
    // 1,000 sq ft x 5.4 in x 1.25 waste.
    const o = option('better', 3580, { lines: [insulation('ocsf', 6750)] });
    expect(kinds(checkCavityNotOverfilled(quote([o], [walls])))).toEqual(['cavity_not_overfilled:overfilled_no_depth:better']);
  });
  it('existing insulation counts: a 2x4 full of R-11 batts has no room for 2.5 in more (overfilled)', () => {
    const walls = area({ jobType: 'walls', sqft: 1000, depthIn: 3.5, currentR: 11, existingMaterial: 'Fiberglass batts' });
    const o = option('good', 1500, { lines: [insulation('cellulose', ((2.5 * 1000) / 200) * 1.08)] });
    expect(kinds(checkCavityNotOverfilled(quote([o], [walls])))).toEqual(['cavity_not_overfilled:overfilled:good']);
    // Removed first, the same fill fits.
    const removed = { ...o, lines: [...o.lines, line({ kind: 'removal', product: 'removal' })] };
    expect(checkCavityNotOverfilled(quote([removed], [walls]))).toEqual([]);
  });
  it('a batt is as thick as its R: an R-38 batt does not fit a 5.5 in floor cavity', () => {
    const crawl = area({ jobType: 'crawlspace', sqft: 800, depthIn: 5.5 });
    const o = option('good', 2270, { lines: [insulation('batts', 840)], customerItems: [item('Fiberglass Batts, R-38, 800 sq ft', 2270)] });
    expect(kinds(checkCavityNotOverfilled(quote([o], [crawl])))).toEqual(['cavity_not_overfilled:overfilled:good']);
  });
  it('passes a full cavity, one whole bag on a tiny wall, and an open attic of any depth', () => {
    const walls = area({ jobType: 'walls', sqft: 1000, depthIn: 3.5 });
    expect(checkCavityNotOverfilled(quote([option('good', 1, { lines: [insulation('cellulose', 19)] })], [walls]))).toEqual([]);
    const tiny = area({ jobType: 'walls', sqft: 0.3 });
    expect(checkCavityNotOverfilled(quote([option('good', 1, { lines: [insulation('cellulose', 1)] })], [tiny]))).toEqual([]);
    expect(checkCavityNotOverfilled(quote([option('good', 1, { lines: [insulation('cellulose', 200)] })], [area()]))).toEqual([]);
  });
});

describe('finite_amounts: no blank, infinite or negative amount', () => {
  it('fails on a blank price and a negative item; a price adjustment may be negative', () => {
    const bad = option('good', NaN, { customerItems: [item('Work', -5)] });
    expect(kinds(checkFiniteAmounts(quote([bad])))).toEqual(expect.arrayContaining(['finite_amounts:not_finite:good', 'finite_amounts:negative:good']));
    const ok = option('good', 1000, { customerItems: [item('Work', 1095), item('Price adjustment', -95, null, 'adjustment')] });
    expect(checkFiniteAmounts(quote([ok]))).toEqual([]);
  });
});

describe('checkPricedQuote runs every engine rule', () => {
  it('reports each broken rule once, by id', () => {
    const walls = area({ jobType: 'walls', sqft: 1000 });
    const o1 = option('good', 1500, { label: 'Dense-Pack Cellulose to Code', lines: [insulation('cellulose', 30)], customerItems: [item('Cellulose', 1499.6)] });
    const o2 = option('better', 1500, { lines: [insulation('ocsf', 6750)], customerItems: [item('Open-cell', 1500)] });
    const ids = new Set(checkPricedQuote(quote([o1, o2], [walls])).map((v) => v.invariant));
    expect([...ids].sort()).toEqual(['cavity_not_overfilled', 'items_add_up', 'options_step_up']);
    expect(INVARIANT_IDS).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// Quote-level rules
// ---------------------------------------------------------------------------

function doc(o: Partial<QuoteDocument> = {}): QuoteDocument {
  const settings = quoteSettingsFromRows([]);
  return {
    quoteNumber: 'Q-2026-0001-v1',
    version: 1,
    issuedAt: '2026-11-18T02:30:00.000Z',
    validUntil: '2026-12-17',
    branding: settings.branding,
    customer: { name: 'Sample Customer', email: 'customer@example.com', phone: null },
    property: { line1: '1 Sample Street', line2: 'Sampletown, ST 00000' },
    estimator: { name: 'Sample Estimator', email: null },
    options: [
      { tier: 'good', label: 'Blown Cellulose to Code', bullets: ['Brings your attic to current code R-value'], items: [{ areaName: 'Attic', description: 'Cellulose', price: 4321.5 }], price: 4321.5, financing: null },
      { tier: 'better', label: 'Air Seal + Blown Cellulose', bullets: [], items: [{ areaName: 'Attic', description: 'Cellulose', price: 5060 }], price: 5060, financing: null },
    ],
    recommendedTier: 'better',
    notes: null,
    terms: settings.terms,
    warranty: settings.warranty,
    ...o,
  };
}

describe('same_price_text (S1-F1, OD1, OD4): one price, one reading, in whole dollars', () => {
  it('every surface in PRICE_SURFACES still prints a price where the list says it does', () => {
    for (const id of SURFACE_IDS) {
      const s = PRICE_SURFACES[id];
      expect(read(s.file), `${id}: ${s.file} no longer contains ${s.snippet}; update PRICE_SURFACES and priceTexts`).toContain(s.snippet);
    }
  });

  it('reads the price off every option surface, rendering the signing page and the emails for real', () => {
    const d = doc();
    for (const o of d.options) {
      const texts = priceTexts(d, o.tier);
      for (const id of SURFACE_IDS.filter((s) => PRICE_SURFACES[s].reads !== 'headline')) {
        expect(texts[id], id).toBeDefined();
        for (const t of texts[id]!) expect(t, `${id} for ${o.tier}`).toMatch(/^\$[\d,]+(\.\d\d)?$/);
      }
    }
  });

  it('a surface that reads anything but the whole-dollar price is a violation of that surface', () => {
    const v = compareReadings('good', '$4,322', { pdf: ['$4,322'], accept_sentence: ['$4,321.50'], quote_email: ['$4,322', '$4,321.5'] });
    expect(kinds(v)).toEqual(['same_price_text:accept_sentence:good', 'same_price_text:quote_email:good']);
    expect(v[1]!.detail).toContain('"$4,321.5"');
    expect(compareReadings('good', '$4,322', { pdf: ['$4,322'], sign_button: ['$4,322'] })).toEqual([]);
  });

  it('checkSamePriceText reports exactly the surfaces whose reading differs', () => {
    const d = doc();
    const v = checkSamePriceText(d);
    for (const o of d.options) {
      const texts = priceTexts(d, o.tier);
      const differs = SURFACE_IDS.filter((id) => (texts[id] ?? []).some((t) => t !== dollarsText(o.price)));
      expect(v.filter((x) => x.tier === o.tier).map((x) => x.kind)).toEqual(differs);
    }
  });

  it('the headline is the recommended option: the pick, else Better, else the first option (OD1)', () => {
    const options = [
      { tier: 'good' as const, price: 2375 },
      { tier: 'better' as const, price: 4095 },
    ];
    expect(expectedHeadline({ selectedTier: null, options, modelTotalPrice: 2375, signedPrice: null })).toEqual({ tier: 'better', price: 4095 });
    expect(expectedHeadline({ selectedTier: 'good', options, modelTotalPrice: 2375, signedPrice: null })).toEqual({ tier: 'good', price: 2375 });
    expect(expectedHeadline({ selectedTier: 'best', options: options.slice(0, 1), modelTotalPrice: null, signedPrice: null })).toEqual({ tier: 'good', price: 2375 });
    expect(expectedHeadline({ selectedTier: 'best', options, modelTotalPrice: null, signedPrice: 4400 })).toEqual({ tier: 'best', price: 4400 });
    expect(expectedHeadline({ selectedTier: null, options: [], modelTotalPrice: null, signedPrice: null })).toBeNull();
    const texts = headlineTexts({ selectedTier: null, options, modelTotalPrice: 2375, signedPrice: null });
    expect(Object.keys(texts).sort()).toEqual(['field_card', 'office_list']);
  });
});

describe('valid_until_is_expiry (S1-F8, OD11): "Valid until" is the last day the link works', () => {
  // The evening send: sent 2026-11-18 at 02:30 UTC (9:30 PM the evening before in New York), for
  // 30 days. The link works until 2026-12-18 02:30 UTC, which is Dec 17 in the business zone.
  const sent = '2026-11-18T02:30:00.000Z';
  it('the link expiry is the send time plus the days, as the send route stores it', () => {
    expect(linkExpiresAt(sent, 30).toISOString()).toBe('2026-12-18T02:30:00.000Z');
  });
  it('a quote printing Dec 18 for a link that dies on the evening of Dec 17 is a day late', () => {
    const v = checkValidUntilIsExpiry(doc({ validUntil: '2026-12-18' }), linkExpiresAt(sent, 30));
    expect(kinds(v)).toEqual(['valid_until_is_expiry:day_after:null']);
  });
  it('a quote printing Dec 17 for it is right, and so is one sent at noon', () => {
    expect(checkValidUntilIsExpiry(doc({ validUntil: '2026-12-17' }), linkExpiresAt(sent, 30))).toEqual([]);
    expect(checkValidUntilIsExpiry(doc({ validUntil: '2026-12-18' }), linkExpiresAt('2026-11-18T17:00:00.000Z', 30))).toEqual([]);
  });
  it('a date before the real expiry is a violation too', () => {
    expect(kinds(checkValidUntilIsExpiry(doc({ validUntil: '2026-12-16' }), linkExpiresAt(sent, 30)))).toEqual(['valid_until_is_expiry:day_before:null']);
  });
});

// ---------------------------------------------------------------------------
// The random quotes
// ---------------------------------------------------------------------------

describe('random quotes (lib/pricing/__fixtures__/random.ts)', () => {
  const quotes = randomQuotes(3000, 20261118, seededBundle);

  it('are the same for the same seed, and different for another', () => {
    const r = mulberry32(7);
    const again = mulberry32(7);
    expect([r(), r(), r()]).toEqual([again(), again(), again()]);
    expect(randomQuotes(50, 20261118, seededBundle)).toEqual(quotes.slice(0, 50));
    expect(randomQuotes(50, 1, seededBundle)).not.toEqual(quotes.slice(0, 50));
  });

  it('cover every edge the audit lists', () => {
    const areas = quotes.flatMap((q) => q.input.areas);
    const has = (f: (a: AreaInput) => boolean) => areas.some(f);
    for (const jt of JOB_TYPES) expect(has((a) => a.jobType === jt), jt).toBe(true);
    for (const level of ACCESS_LEVELS) expect(has((a) => a.accessLevel === level), level).toBe(true);
    expect(has((a) => a.sqft === 0.3)).toBe(true);
    expect(has((a) => a.sqft === 200_000)).toBe(true);
    expect(has((a) => a.sqft < 10)).toBe(true);
    expect(has((a) => a.currentR > 0 && a.existingDepthIn !== null)).toBe(true);
    expect(has((a) => a.currentR > 0 && a.existingDepthIn === null)).toBe(true);
    expect(has((a) => !!a.existingMaterial && a.existingMaterial === a.existingMaterial.toLowerCase())).toBe(true);
    expect(has((a) => a.currentR > 0 && a.existingMaterial === null)).toBe(true);
    expect(has((a) => a.jobType === 'walls' && a.depthIn === null)).toBe(true);
    expect(has((a) => a.jobType === 'walls' && a.depthIn === 3.5)).toBe(true);
    expect(has((a) => a.removalNeeded)).toBe(true);
    expect(has((a) => a.targetR !== null)).toBe(true);
    const drives = quotes.map((q) => q.input.driveMinutesOneWay);
    expect(drives).toContain(null);
    expect(drives).toContain(0);
    expect(drives.some((d) => d !== null && d >= 90)).toBe(true);
    const prices = quotes.flatMap((q) => Object.values(q.input.overrides).map((o) => o!.price));
    expect(prices.some((p) => !Number.isInteger(p))).toBe(true);
    expect(prices.some((p) => Number.isInteger(p))).toBe(true);
    expect(quotes.some((q) => Object.values(q.input.lineOverrides ?? {}).some((l) => l.qty != null))).toBe(true);
    expect(quotes.some((q) => Object.values(q.input.lineOverrides ?? {}).some((l) => l.hours != null))).toBe(true);
    const crewIds = new Set(seededBundle.snapshot.crews.map((c) => c.id));
    expect(quotes.some((q) => q.input.crewId !== null && !crewIds.has(q.input.crewId))).toBe(true);
    expect(quotes.some((q) => q.selectedTier === null)).toBe(true);
    const months = new Set(quotes.map((q) => q.issuedAt.slice(0, 7)));
    expect(months.size).toBe(12);
    expect([...months].every((m) => m.startsWith('2026-'))).toBe(true);
    expect(new Set(quotes.map((q) => q.validDays)).size).toBeGreaterThan(1);
  });

  it('are estimates the app accepts, and the engine prices every one', () => {
    for (const q of quotes) {
      for (const a of q.input.areas) expect(areaSchema.safeParse(a).success).toBe(true);
      expect(() => priceSeeded(q.input)).not.toThrow();
    }
  });
});
