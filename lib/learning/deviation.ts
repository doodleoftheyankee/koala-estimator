// Deviation flags (PLAN.md §6.5): where the estimator's quantities, hours or price differ from
// what the active model predicts for the same inputs by more than the configured threshold,
// with plain-English reasons that name the coefficients behind the model value. Pure.
import {
  findCoefficient,
  type AreaInput,
  type Coefficient,
  type EstimateInput,
  type JobType,
  type PricedEstimate,
  type PricedLine,
  type PricedOption,
  type PricingBundle,
  type ProductCode,
  type ProductUnit,
} from '@/lib/pricing';
import type { DeviationFlag, DeviationOutcome, DeviationReason } from './types';

type Bundle = Pick<PricingBundle, 'snapshot' | 'coefficientSet'>;

const EPS = 1e-9; // float noise: a deviation of exactly the threshold is not flagged
const LOW_CONFIDENCE = 50; // below this confidence (0-100) the model defers to the estimator
const LOW_SAMPLE = 5; // ...or with fewer jobs than this behind the coefficient
const PCT_DIFF_LIMIT = 9999; // deviation_flags.pct_diff is numeric(8,4)
const TIE_SHARE = 0.02; // errors within 2% of the actual value are a tie

const LOW_CONFIDENCE_TEXT = 'The model has little data here, so your judgement may well be better — explain it.';

const JOB_PLACES: Record<JobType, string> = {
  attic: 'attics',
  walls: 'walls',
  crawlspace: 'crawlspaces',
  rim_joist: 'rim joists',
  garage: 'garages',
  commercial: 'commercial jobs',
};

const UNITS: Record<ProductUnit, [one: string, many: string]> = {
  board_ft: ['board ft', 'board ft'],
  bag: ['bag', 'bags'],
  sqft: ['sq ft', 'sq ft'],
  linear_ft: ['linear ft', 'linear ft'],
  hour: ['h', 'h'],
  each: ['unit', 'units'],
};

/**
 * Compares what the estimator will quote against what the active model predicts for the
 * same inputs (PLAN.md §6.5). A flag is raised when |pctDiff| > settings.deviationThreshold:
 *  - per overridden line (metric 'qty' for material lines, 'hours' for labor/removal lines),
 *    deduplicated across tiers by key `${lineKey}|${metric}` (tier = first tier containing it);
 *  - per option whose final price differs from modelPrice (key `${tier}|total_price`).
 * Reasons name the coefficients behind the model value (value, scope, sample size, confidence).
 */
export function computeDeviationFlags(
  priced: PricedEstimate,
  input: EstimateInput,
  bundle: Pick<PricingBundle, 'snapshot' | 'coefficientSet'>,
): DeviationFlag[] {
  const t = bundle.snapshot.settings.deviationThreshold;
  // A broken threshold must not silently switch flags off: fall back to flagging any change.
  const threshold = Number.isFinite(t) && t >= 0 ? t : 0;
  const areas = new Map(input.areas.map((a) => [a.id, a]));

  const flags: DeviationFlag[] = [];
  const seen = new Set<string>();
  for (const option of priced.options) {
    for (const line of option.lines) {
      const flag = lineFlag(option, line, areas, threshold, bundle);
      // The same line appears in several tiers; the estimator explains it once.
      if (flag && !seen.has(flag.key)) {
        seen.add(flag.key);
        flags.push(flag);
      }
    }
  }
  for (const option of priced.options) {
    const flag = totalFlag(option, threshold);
    if (flag) flags.push(flag);
  }
  return flags;
}

/** After the job: who was closer to the actual value? Within 2% of each other is a tie. */
export function deviationOutcome(estimatorValue: number, modelValue: number, actualValue: number): DeviationOutcome {
  if (![estimatorValue, modelValue, actualValue].every(Number.isFinite)) return 'tie';
  const estErr = Math.abs(estimatorValue - actualValue);
  const modelErr = Math.abs(modelValue - actualValue);
  if (Math.abs(estErr - modelErr) <= TIE_SHARE * Math.abs(actualValue)) return 'tie';
  return estErr < modelErr ? 'estimator_closer' : 'model_closer';
}

// ---------------------------------------------------------------------------
// Line flags
// ---------------------------------------------------------------------------

function lineFlag(
  option: PricedOption,
  line: PricedLine,
  areas: Map<string, AreaInput>,
  threshold: number,
  bundle: Bundle,
): DeviationFlag | null {
  if (!line.isOverridden || !line.key || !line.product) return null;
  const metric = line.kind === 'material' ? 'qty' : line.kind === 'labor' || line.kind === 'removal' ? 'hours' : null;
  if (!metric) return null;
  const est = metric === 'qty' ? line.qty : line.hours;
  const model = metric === 'qty' ? line.modelQty : line.modelHours;
  if (est === null || model === null || !Number.isFinite(est) || !Number.isFinite(model) || model <= 0) return null;
  const pct = (est - model) / model;
  if (!(Math.abs(pct) > threshold + EPS)) return null;

  const area = line.areaId ? areas.get(line.areaId) : undefined;
  const product = line.product;
  const reasons = metric === 'hours' ? hoursReasons(line, product, area, bundle) : qtyReasons(line, product, area, bundle);

  const what = metric === 'qty' ? 'Material quantity' : line.kind === 'removal' ? 'Removal hours' : 'Labor hours';
  const amount = (n: number) => withUnit(n, metric === 'hours' ? 'hour' : line.unit);
  const message =
    `${what} ${fmtPct(pct)} ${pct > 0 ? 'above' : 'below'} model for ${area?.name ?? 'this area'} (${productLabel(bundle, product)}): ` +
    `you entered ${amount(est)}, the model predicts ${amount(model)}.`;

  return {
    key: `${line.key}|${metric}`,
    tier: option.tier,
    lineKey: line.key,
    metric,
    estimatorValue: est,
    modelValue: model,
    pctDiff: storedPct(pct),
    reasons,
    message,
  };
}

/**
 * Hours = setup + design units x rate x access multiplier (removal: setup + sqft x rate x access).
 * Coefficients are looked up with the same scopes the engine uses, so the reasons name exactly
 * the values that produced the model hours.
 */
function hoursReasons(line: PricedLine, product: ProductCode, area: AreaInput | undefined, bundle: Bundle): DeviationReason[] {
  const set = bundle.coefficientSet;
  const jobType = area?.jobType ?? null;
  const removal = line.kind === 'removal';
  const reasons: DeviationReason[] = [];

  const rate = removal
    ? findCoefficient(set, 'removal_hrs_per_sqft', { jobType })
    : findCoefficient(set, 'labor_hrs_per_unit', { product, jobType });
  if (rate) {
    const what = removal
      ? `Removal rate ${fmtCoef(rate.value)} h per sq ft`
      : `Labor rate ${fmtCoef(rate.value)} h per ${rateUnit(bundle, product)} for ${productLabel(bundle, product).toLowerCase()}`;
    reasons.push({ code: 'labor_rate', text: `${what}${placeText(jobType)} (${evidence(rate)}).` });
  }

  if (area) {
    const access = findCoefficient(set, 'access_mult', { accessLevel: area.accessLevel });
    if (access) {
      reasons.push({ code: 'access', text: `Access multiplier ×${fmtCoef(access.value)} for ${area.accessLevel} access (${evidence(access)}).` });
    }
  }

  const setup = findCoefficient(set, 'setup_hours', removal ? { product: 'removal' } : { product, jobType });
  if (setup && setup.value > 0) {
    reasons.push({
      code: 'setup',
      text: `Setup ${fmtVal(setup.value)} h per area for ${productLabel(bundle, product).toLowerCase()} (${evidence(setup)}).`,
    });
  }

  if (isLowConfidence(rate)) reasons.push({ code: 'low_confidence', text: LOW_CONFIDENCE_TEXT });
  return reasons;
}

/** Quantity = design units (from area, R-value, coverage) x waste factor. */
function qtyReasons(line: PricedLine, product: ProductCode, area: AreaInput | undefined, bundle: Bundle): DeviationReason[] {
  const jobType = area?.jobType ?? null;
  const label = productLabel(bundle, product).toLowerCase();
  const design = line.designQty;
  const implied = design !== null && design > 0 ? line.qty / design : null;
  const impliedText = implied !== null ? `; your quantity implies ${fmtCoef(implied)}` : '';
  const reasons: DeviationReason[] = [];

  const waste = findCoefficient(bundle.coefficientSet, 'waste_factor', { product, jobType });
  reasons.push({
    code: 'waste',
    text: waste
      ? `Waste factor ${fmtCoef(waste.value)} for ${label}${placeText(jobType)} (${evidence(waste)})${impliedText}.`
      : `No waste factor is set for ${label}, so the model uses the design quantity${impliedText}.`,
  });
  if (design !== null) {
    reasons.push({ code: 'design_qty', text: `Design quantity before waste: ${withUnit(design, line.unit)}.` });
  }
  if (isLowConfidence(waste)) reasons.push({ code: 'low_confidence', text: LOW_CONFIDENCE_TEXT });
  return reasons;
}

// ---------------------------------------------------------------------------
// Total flags
// ---------------------------------------------------------------------------

function totalFlag(option: PricedOption, threshold: number): DeviationFlag | null {
  const model = option.modelPrice;
  const est = option.price;
  if (!Number.isFinite(model) || model <= 0 || !Number.isFinite(est)) return null;
  const pct = (est - model) / model;
  if (!(Math.abs(pct) > threshold + EPS)) return null;

  const reasons: DeviationReason[] = [];
  if (option.isOverridden) {
    reasons.push({ code: 'price_override', text: `Price set by hand: ${option.overrideReason?.trim() || 'no reason given'}.` });
  }
  if (option.hasLineOverrides) {
    const changed = option.lines.filter((l) => l.isOverridden);
    reasons.push({
      code: 'line_overrides',
      text:
        `Your changes to ${changed.length} ${changed.length === 1 ? 'line' : 'lines'} (${changed.map((l) => l.description).join(', ')}) ` +
        `move the price to ${usd(option.adjustedPrice)}.`,
    });
  }

  return {
    key: `${option.tier}|total_price`,
    tier: option.tier,
    lineKey: null,
    metric: 'total_price',
    estimatorValue: est,
    modelValue: model,
    pctDiff: storedPct(pct),
    reasons,
    message: `${capitalize(option.tier)} option price ${fmtPct(pct)} ${pct > 0 ? 'above' : 'below'} model: you are quoting ${usd(est)}, the model price is ${usd(model)}.`,
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** "based on 27 jobs, confidence 81", or the prior's disclaimer. */
function evidence(c: Coefficient): string {
  const n = c.sampleSize;
  if (!(typeof n === 'number' && n > 0)) return 'starting estimate, no job data yet';
  const jobs = `based on ${fmtVal(n)} ${n === 1 ? 'job' : 'jobs'}`;
  const conf = c.confidence;
  return typeof conf === 'number' && Number.isFinite(conf) ? `${jobs}, confidence ${Math.round(conf)}` : jobs;
}

/** A missing coefficient, or one with little evidence behind it (priors have none). */
function isLowConfidence(c: Coefficient | null): boolean {
  return !c || (c.confidence ?? 0) < LOW_CONFIDENCE || (c.sampleSize ?? 0) < LOW_SAMPLE;
}

/** The unit a labor rate is per: design units, as the engine computes them. */
function rateUnit(bundle: Bundle, product: ProductCode): string {
  if (product === 'air_sealing') return UNITS.sqft[0];
  const unit = bundle.snapshot.materials.find((m) => m.productCode === product)?.unit;
  return UNITS[unit === 'board_ft' || unit === 'bag' ? unit : 'sqft'][0];
}

function productLabel(bundle: Bundle, product: ProductCode): string {
  return bundle.snapshot.products.find((p) => p.code === product)?.label ?? product;
}

function placeText(jobType: JobType | null): string {
  return jobType ? ` in ${JOB_PLACES[jobType]}` : '';
}

/** "14 h", "58 bags", "1 bag", "1,200 board ft". */
function withUnit(n: number, unit: ProductUnit | null): string {
  if (!unit) return fmtVal(n);
  const [one, many] = UNITS[unit];
  return `${fmtVal(n)} ${n === 1 ? one : many}`;
}

/** Signed fraction, 4 decimals, within what the database column can hold. */
function storedPct(p: number): number {
  return Math.max(-PCT_DIFF_LIMIT, Math.min(PCT_DIFF_LIMIT, Math.round(p * 10000) / 10000));
}

/** "38%", or one decimal near the threshold ("15.1%"). */
function fmtPct(p: number): string {
  const v = Math.abs(p) * 100;
  return `${v >= 20 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}

/** Quantities and hours: whole numbers from 100, one decimal from 10, else two. */
function fmtVal(n: number): string {
  const a = Math.abs(n);
  return n.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 });
}

/** Coefficients and ratios: three significant digits (0.15, 0.004, 1.08). */
function fmtCoef(n: number): string {
  return n.toLocaleString('en-US', { maximumSignificantDigits: 3 });
}

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
