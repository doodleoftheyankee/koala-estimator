// Random quotes for the accuracy checks: thousands of estimates an estimator could really enter,
// with every edge the audit found, from a seed. The same seed always draws the same areas, crews,
// drives, picks and dates, whatever the engine or the prices (review A F7); the estimator's price
// and line changes are drawn from each quote's own stream and start from the engine's numbers.
//
// Covers every job type; sizes from 0.3 sq ft up to the 200,000 sq ft cap (lib/sync/draft.ts);
// every access level; existing insulation with and without a depth, its material named as the area
// form names it, in lower case, or not at all; cavity depths and none; removal; target R-values
// (below code included); drive times null, 0 and long; price overrides of up to 30% either way,
// some with cents; line overrides (material quantities and hours, for one option or all); a crew id
// that is not in the setup; the estimator's pick (or none); issue times across 2026 and the
// quote's validity in days.
import { EXISTING_MATERIALS } from '@/lib/pricing/rPerInch';

/**
 * The R per inch the generator draws existing depths with: the table as it was on 2026-11-18, kept
 * here so the same seed draws the same quotes after the app's table changes (L24 moved cellulose
 * to 3.6 and "Other" to 3.2). Only the generator uses it; the checks read the app's table.
 */
const R_PER_INCH: Readonly<Record<(typeof EXISTING_MATERIALS)[number], number>> = {
  None: 0,
  'Fiberglass batts': 3.2,
  'Blown fiberglass': 2.5,
  Cellulose: 3.5,
  'Rock wool': 3.1,
  Vermiculite: 2.1,
  'Spray foam': 3.7,
  Other: 2.5,
};
import { priceEstimate } from '../engine';
import {
  JOB_TYPES,
  type AccessLevel,
  type AreaInput,
  type EstimateInput,
  type JobType,
  type LineOverride,
  type PriceOverride,
  type PricingBundle,
  type Tier,
} from '../types';

export type Rng = () => number;

/** mulberry32: a small, fast, seedable generator of numbers in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomQuote {
  id: string;
  input: EstimateInput;
  /** The option the estimator picked, or null (the quote then recommends Better). */
  selectedTier: Tier | null;
  /** When the quote is sent (ISO). */
  issuedAt: string;
  /** How many days the quote is valid. */
  validDays: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const chance = (r: Rng, p: number) => r() < p;
const between = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const round = (n: number, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

function weighted<T>(r: Rng, xs: ReadonlyArray<readonly [T, number]>): T {
  const total = xs.reduce((a, [, w]) => a + w, 0);
  let x = r() * total;
  for (const [v, w] of xs) {
    if ((x -= w) < 0) return v;
  }
  return xs[xs.length - 1]![0];
}

/** A UUID (v4 layout) from the generator, so ids are part of the seed too. */
export function randomUuid(r: Rng): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Math.floor(r() * 4)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

/** Typical sizes (sq ft) per job type. */
const TYPICAL_SQFT: Record<JobType, readonly [number, number]> = {
  attic: [300, 3000],
  walls: [150, 3000],
  crawlspace: [150, 2000],
  rim_joist: [40, 400],
  garage: [150, 1000],
  commercial: [1000, 20000],
};

/** R-values estimators find already in place, per job type. */
const EXISTING_R: Record<JobType, readonly number[]> = {
  attic: [7, 11, 13, 19, 22, 30, 38, 49, 60],
  walls: [4, 7, 11, 13, 15, 19],
  crawlspace: [11, 13, 19, 30],
  rim_joist: [8, 11, 13, 19],
  garage: [11, 13, 19, 30],
  commercial: [11, 19, 30],
};

/** Target R-values estimators type, per job type (some below code on purpose). */
const TARGET_R: Record<JobType, readonly number[]> = {
  attic: [30, 38, 44, 49, 60],
  walls: [11, 13, 15, 19, 21, 23],
  crawlspace: [13, 19, 21, 30, 38],
  rim_joist: [10, 13, 15, 19],
  garage: [13, 19, 30, 38],
  commercial: [13, 19, 30, 38],
};

/** Cavity depths (in) when an estimator enters one, per job type, and how often they do. */
const DEPTHS: Record<JobType, { p: number; depths: readonly number[] }> = {
  attic: { p: 0.08, depths: [5.5, 7.25, 9.25, 11.25] },
  walls: { p: 0.65, depths: [3.5, 3.5, 3.5, 5.5, 5.5, 7.25] },
  crawlspace: { p: 0.35, depths: [5.5, 7.25, 9.25, 11.25] },
  rim_joist: { p: 0.5, depths: [5.5, 7.25, 9.25, 11.25] },
  garage: { p: 0.25, depths: [3.5, 5.5, 7.25, 9.25] },
  commercial: { p: 0.1, depths: [3.5, 5.5, 7.25] },
};

const AREA_NAMES: Record<JobType, string> = {
  attic: 'Attic',
  walls: 'Exterior walls',
  crawlspace: 'Crawlspace',
  rim_joist: 'Basement rim joist',
  garage: 'Garage',
  commercial: 'Commercial area',
};

const ACCESS_WEIGHTS: ReadonlyArray<readonly [AccessLevel, number]> = [
  ['easy', 0.4],
  ['moderate', 0.3],
  ['difficult', 0.2],
  ['extreme', 0.1],
];

function randomSqft(r: Rng, jobType: JobType): number {
  const roll = r();
  if (roll < 0.03) return chance(r, 0.3) ? 0.3 : round(between(r, 0.3, 10), 1); // tiny, down to 0.3 sq ft
  if (roll < 0.06) return chance(r, 0.3) ? 200_000 : round(between(r, 20_000, 200_000)); // huge, up to the cap
  const [lo, hi] = TYPICAL_SQFT[jobType];
  const n = between(r, lo, hi);
  return chance(r, 0.2) ? round(n, 1) : round(n);
}

/** One area: area number `i` of a quote, of `jobType` or a random one. */
export function randomArea(r: Rng, i: number, jobType?: JobType): AreaInput {
  const jt = jobType ?? pick(r, JOB_TYPES);
  const sqft = randomSqft(r, jt);
  const accessLevel = weighted(r, ACCESS_WEIGHTS);

  let currentR = 0;
  let existingMaterial: string | null = null;
  let existingDepthIn: number | null = null;
  const hasExisting = !chance(r, 0.4);
  if (hasExisting) {
    const material = pick(r, EXISTING_MATERIALS.filter((m) => m !== 'None'));
    const how = r();
    // As the form names it (75%), in lower case (15%), or not named at all (10%).
    existingMaterial = how < 0.75 ? material : how < 0.9 ? material.toLowerCase() : null;
    // A material named with no R-value read yet (5%).
    currentR = existingMaterial && chance(r, 0.05) ? 0 : pick(r, EXISTING_R[jt]);
    if (chance(r, 0.5)) {
      const perInch = R_PER_INCH[material] || 3;
      existingDepthIn = currentR > 0 ? Math.max(0.5, round((currentR / perInch) * between(r, 0.8, 1.2), 1)) : round(between(r, 1, 6), 1);
    }
  }

  const d = DEPTHS[jt];
  const depthIn = chance(r, d.p) ? (chance(r, 0.05) ? round(between(r, 2, 12), 2) : pick(r, d.depths)) : null;
  const targetR = chance(r, 0.55) ? null : chance(r, 0.1) ? pick(r, [5, 8, 11, 13, 19, 25, 30, 38, 49, 60, 70]) : pick(r, TARGET_R[jt]);
  const removalNeeded = chance(r, hasExisting ? 0.2 : 0.03);

  return {
    id: randomUuid(r),
    name: i === 0 ? AREA_NAMES[jt] : `${AREA_NAMES[jt]} ${i + 1}`,
    jobType: jt,
    sqft,
    currentR,
    targetR,
    existingMaterial,
    existingDepthIn,
    depthIn,
    accessLevel,
    removalNeeded,
    prepNotes: null,
  };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

const YEAR_START = Date.UTC(2026, 0, 1);
const YEAR_MS = Date.UTC(2027, 0, 1) - YEAR_START;

/**
 * A price an estimator might type: up to 30% either way (from `u` in [0, 1)), whole dollars, a
 * round $5, or with cents (from `style` in [0, 1)).
 */
function overridePrice(u: number, style: number, model: number): number {
  const p = Math.max(1, model * (1 + (-0.3 + u * 0.6)));
  if (style < 0.3) {
    const cents = Math.round(p * 100) / 100;
    return Number.isInteger(cents) ? cents + 0.5 : cents; // with cents, like $4,321.50
  }
  if (style < 0.65) return Math.round(p);
  return Math.max(5, Math.round(p / 5) * 5);
}

/** The tiers, in order, for the estimator's price changes (each tier draws its own numbers). */
const TIER_ORDER: readonly Tier[] = ['good', 'better', 'best'];

/**
 * Quote number `n` of a run. `bundle` is the pricing it is priced with (overrides start from its prices).
 *
 * Everything but the estimator's changes is drawn from `r` in a fixed order and number of draws,
 * whatever the engine returns, so the same seed draws the same quotes with any engine and any
 * prices (review A F7). The changes (which option and line, the factor, which prices) come from a
 * stream of the quote's own, seeded from `r`, with a fixed number of draws per tier and per line
 * change; they are applied to whatever the engine returns for this quote.
 */
export function randomQuote(r: Rng, n: number, bundle: PricingBundle): RandomQuote {
  const id = randomUuid(r);
  const count = weighted(r, [
    [1, 0.6],
    [2, 0.25],
    [3, 0.1],
    [4, 0.03],
    [5, 0.02],
  ] as const);
  const areas = Array.from({ length: count }, (_, i) => randomArea(r, i));
  const crewChoice = weighted(r, [
    ['none', 0.7],
    ['default', 0.2],
    ['missing', 0.1],
  ] as const);
  const crewId = crewChoice === 'none' ? null : crewChoice === 'default' ? bundle.snapshot.defaultCrewId : randomUuid(r);
  const driveKind = weighted(r, [
    ['null', 0.15],
    ['zero', 0.1],
    ['typical', 0.65],
    ['long', 0.1],
  ] as const);
  const driveMinutesOneWay =
    driveKind === 'null' ? null : driveKind === 'zero' ? 0 : driveKind === 'typical' ? round(between(r, 5, 60)) : round(between(r, 90, 600));
  const selectedTier = weighted<Tier | null>(r, [
    [null, 0.15],
    ['good', 0.15],
    ['better', 0.55],
    ['best', 0.15],
  ]);
  const wantsLines = chance(r, 0.1);
  const wantsPrice = chance(r, 0.15);
  const changes = mulberry32(Math.floor(r() * 4294967296));
  const issuedAt = new Date(YEAR_START + Math.floor(r() * (YEAR_MS / 1000)) * 1000).toISOString();
  const validDays = chance(r, 0.8) ? bundle.snapshot.settings.quoteValidDays : pick(r, [7, 14, 45, 60]);
  const input: EstimateInput = { areas, crewId, driveMinutesOneWay, overrides: {}, lineOverrides: {} };

  // Estimator changes start from the model's own numbers.
  if (wantsLines || wantsPrice) {
    // Every draw is made whether or not it is used, so one tier's decision never depends on another's.
    const howMany = chance(changes, 0.7) ? 1 : 2;
    const lineDraws = [0, 1].map(() => ({ option: changes(), line: changes(), factor: between(changes, 0.5, 1.6), ownTier: chance(changes, 0.7) }));
    const priceDraws = TIER_ORDER.map((tier) => ({ tier, wanted: chance(changes, 0.6), u: changes(), style: changes() }));
    const fallback = { option: changes(), u: changes(), style: changes() };

    const model = priceEstimate(input, bundle.snapshot, bundle.coefficientSet);
    if (wantsLines && model.options.length) {
      const lineOverrides: Record<string, LineOverride> = {};
      for (const d of lineDraws.slice(0, howMany)) {
        const option = model.options[Math.floor(d.option * model.options.length)]!;
        const lines = option.lines.filter((l) => l.key !== null && (l.kind === 'material' || l.kind === 'labor' || l.kind === 'removal'));
        if (!lines.length) continue;
        const line = lines[Math.floor(d.line * lines.length)]!;
        const tier = d.ownTier ? option.tier : null;
        lineOverrides[line.key!] =
          line.kind === 'material'
            ? { qty: line.unit === 'bag' ? Math.max(0, Math.round((line.modelQty ?? line.qty) * d.factor)) : round((line.modelQty ?? line.qty) * d.factor, 1), reason: 'Counted on site', tier }
            : { hours: round((line.modelHours ?? line.qty) * d.factor, 2), reason: 'Crew estimate', tier };
      }
      input.lineOverrides = lineOverrides;
    }
    if (wantsPrice && model.options.length) {
      const overrides: Partial<Record<Tier, PriceOverride>> = {};
      for (const d of priceDraws) {
        const o = model.options.find((x) => x.tier === d.tier);
        if (o && d.wanted) overrides[o.tier] = { price: overridePrice(d.u, d.style, o.price), reason: 'Matched the competing bid' };
      }
      if (Object.keys(overrides).length === 0) {
        const o = model.options[Math.floor(fallback.option * model.options.length)]!;
        overrides[o.tier] = { price: overridePrice(fallback.u, fallback.style, o.price), reason: 'Matched the competing bid' };
      }
      input.overrides = overrides;
    }
  }

  return { id, input, selectedTier, issuedAt, validDays };
}

/**
 * `count` quotes from `seed`, priced with `bundle`. The same seed always gives the same quotes apart
 * from the estimator's changes, which start from the engine's numbers for the same bundle.
 */
export function randomQuotes(count: number, seed: number, bundle: PricingBundle): RandomQuote[] {
  const r = mulberry32(seed);
  return Array.from({ length: count }, (_, n) => randomQuote(r, n, bundle));
}
