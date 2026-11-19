// The rules every priced quote must keep, written from the accuracy audit (Nov 2026) and the
// owner's decisions (docs/accuracy/spec/owner-decisions.txt), not from how the engine works today.
// Each check reads only what the customer is shown (the options, their items, titles and bullets)
// and what is priced (the lines), and says which rule a quote breaks and where.
//
// The quote-level rules (one price text on every surface, "Valid until" is the real expiry) are in
// lib/quotes/invariants.ts. scripts/accuracy/violations.ts runs all of them over thousands of
// random quotes; lib/accuracy/invariants.test.ts shows each one on hand-made good and bad quotes.
//
// Pure: no I/O, no clock.
import { EXISTING_MATERIALS, EXISTING_R_PER_INCH as R_PER_INCH } from './rPerInch';
import { findCoefficient } from './coefficients';
import type {
  AreaInput,
  CoefficientSet,
  CustomerItem,
  CustomerItemKind,
  EstimateInput,
  JobType,
  PricedEstimate,
  PricedLine,
  PricedOption,
  PricingSnapshot,
  Tier,
} from './types';

export const INVARIANT_IDS = [
  'items_add_up',
  'same_work_same_price',
  'options_step_up',
  'labels_match_work',
  'cavity_not_overfilled',
  'finite_amounts',
  'same_price_text',
  'valid_until_is_expiry',
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

/** One broken rule: which rule, what kind of break, where (option and area) and the numbers. */
export interface Violation {
  invariant: InvariantId;
  kind: string;
  tier: Tier | null;
  areaId: string | null;
  detail: string;
}

/**
 * A priced quote as the checks read it. `coefficients` lets the cavity check take the waste out of
 * a priced quantity. `all` is the same quote priced with every option (priceEstimate showAll), so
 * the checks can see what the customer is not shown (review A F8); without it that is not checked.
 */
export interface PricedQuote {
  input: EstimateInput;
  priced: PricedEstimate;
  snapshot: PricingSnapshot;
  coefficients?: CoefficientSet | null;
  all?: PricedEstimate | null;
}

// ---------------------------------------------------------------------------
// Helpers: what the customer reads
// ---------------------------------------------------------------------------

/**
 * Whole dollars, as a customer surface prints an amount (OD4: whole dollars on every customer
 * surface). Rounds half up from the cent value, the way the whole-dollar formatters
 * (Intl.NumberFormat, maximumFractionDigits 0) print a positive amount: 4321.50 prints $4,322.
 */
export function printedDollars(n: number): number {
  const cents = Math.round(n * 100);
  return Math.sign(cents) * Math.round(Math.abs(cents) / 100);
}

/** The one way a price should read: whole dollars with thousands separators ("$4,322", "-$95"). */
export function dollarsText(n: number): string {
  const d = printedDollars(n);
  return `${d < 0 ? '-' : ''}$${Math.abs(d).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/**
 * The options the customer is shown, in tier order (OD6). Give it the engine's own result
 * (priceEstimate without showAll): the engine leaves out an option that repeats another or does
 * not step up, and says so with an 'option_hidden' warning. An option named in such a warning, or
 * marked hidden, is never counted as shown. (A showAll result has every option and no such
 * warnings, so it is not what the customer sees.)
 */
export function shownOptions(priced: PricedEstimate): PricedOption[] {
  const hidden = new Set(priced.warnings.filter((w) => w.code === 'option_hidden' && w.tier !== null).map((w) => w.tier));
  return priced.options.filter((o) => !hidden.has(o.tier) && (o as { hidden?: boolean }).hidden !== true);
}

/** What a customer item is (CustomerItemKind). An item stored before kinds existed is work. */
export function itemKind(item: Pick<CustomerItem, 'kind'> | { kind?: CustomerItemKind }): CustomerItemKind {
  return item.kind ?? 'work';
}

/**
 * Items that are work in one area (removal, insulation, air sealing). Job-level lines (travel and
 * setup, the minimum job charge, a price adjustment: OD2, OD3) have no area and are not "work".
 */
export function workItems(option: PricedOption): CustomerItem[] {
  return option.customerItems.filter((i) => i.areaId !== null && itemKind(i) === 'work');
}

/** What a work item is, as the customer reads it: the area it is in and what it says. */
export function workSignature(item: Pick<CustomerItem, 'areaId' | 'description'>): string {
  return `${item.areaId}|${item.description.trim().replace(/\s+/g, ' ').toLowerCase()}`;
}

/** Which scope a work item describes, for reporting only. */
export function workScope(description: string): 'removal' | 'air_sealing' | 'insulation' {
  if (/\bremov/i.test(description)) return 'removal';
  if (/\bair[\s-]?seal/i.test(description)) return 'air_sealing';
  return 'insulation';
}

// ---------------------------------------------------------------------------
// Helpers: what is in the wall
// ---------------------------------------------------------------------------

/** OD5: a wall with no depth entered is a 2x4 wall, a 3.5 in cavity. */
export const DEFAULT_WALL_CAVITY_IN = 3.5;
/** Room for rounding (thickness is described to 0.1 in). */
const THICKNESS_TOLERANCE_IN = 0.05;
/** Room for rounding an R-value (described to 0.1). */
const R_TOLERANCE = 0.05;

/**
 * The cavity the insulation has to fit in, in inches: the depth entered, or a 2x4 wall (3.5 in)
 * for walls with none (OD5). Null when there is no cavity to fill (an open attic floor, or a
 * framed area whose depth was not entered).
 */
export function cavityDepth(area: Pick<AreaInput, 'jobType' | 'depthIn'>): number | null {
  if (area.depthIn !== null && Number.isFinite(area.depthIn) && area.depthIn > 0) return area.depthIn;
  return area.jobType === 'walls' ? DEFAULT_WALL_CAVITY_IN : null;
}

/**
 * R per inch of the existing insulation, from the app's one table of existing materials
 * (lib/pricing/rPerInch EXISTING_R_PER_INCH, which the photo read uses too), names matched without regard to case. An unknown or missing
 * material uses the highest R per inch in the table, so the room it takes is never overstated.
 */
export function existingRPerInch(material: string | null): number {
  const name = material?.trim().toLowerCase() ?? '';
  const known = EXISTING_MATERIALS.find((m) => m.toLowerCase() === name);
  const r = known ? R_PER_INCH[known] : 0;
  return r > 0 ? r : Math.max(...Object.values(R_PER_INCH));
}

/** True when the option takes the existing insulation out of this area. */
export function removesExisting(option: PricedOption, areaId: string): boolean {
  return option.lines.some((l) => l.areaId === areaId && l.kind === 'removal');
}

/**
 * How thick the insulation already in the area is, in inches, in this option: none when the option
 * removes it; else the depth entered; else its R-value over its material's R per inch.
 */
export function existingThickness(area: AreaInput, option?: PricedOption): number {
  if (option && removesExisting(option, area.id)) return 0;
  if (area.existingDepthIn !== null && Number.isFinite(area.existingDepthIn) && area.existingDepthIn > 0) return area.existingDepthIn;
  if (area.currentR > 0) return area.currentR / existingRPerInch(area.existingMaterial);
  return 0;
}

/** The R-bearing material lines of one area in an option (what insulates). */
function insulationLines(option: PricedOption, areaId: string, snapshot: PricingSnapshot): PricedLine[] {
  return option.lines.filter(
    (l) => l.areaId === areaId && l.kind === 'material' && !!l.product && !!snapshot.products.find((p) => p.code === l.product)?.isRBearing,
  );
}

function wasteOf(line: PricedLine, area: AreaInput, coefficients: CoefficientSet | null | undefined): number {
  const own = (line as { wasteFactor?: number }).wasteFactor;
  if (typeof own === 'number' && own > 0) return own;
  const c = coefficients ? findCoefficient(coefficients, 'waste_factor', { product: line.product, jobType: area.jobType }) : null;
  if (c && c.value > 0) return c.value;
  if (line.designQty && line.designQty > 0 && line.modelQty && line.modelQty > 0) return line.modelQty / line.designQty;
  return 1;
}

/**
 * The square feet a work item states it covers: "…, 800 sq ft" -> 800, "…, 95 of 800 sq ft" -> 95,
 * "(1,000 sq ft)" -> 1000. Null when it states none.
 */
export function statedSqft(description: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)(?: of \d[\d,]*(?:\.\d+)?)? sq ft/.exec(description);
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
}

/** The R-value a work item states ("… to R-38 …", "Fiberglass Batts, R-38, …"), if any. */
export function statedR(description: string): number | null {
  const m = /\bR-(\d+(?:\.\d+)?)/.exec(description);
  return m ? Number(m[1]) : null;
}

/**
 * Reading a quantity with room for its rounding. `lowerBound`: the least it can install (a bag
 * count is rounded up, so the last bag may be partly used; board feet are rounded to 0.1).
 * `upperBound`: the most (board feet rounded down by up to 0.05).
 */
export interface ThicknessBound {
  lowerBound?: boolean;
  upperBound?: boolean;
}

/**
 * How many inches of insulation the option installs in the area, from the quantity priced (the
 * waste factor taken out). Bags and board feet give a thickness directly. A product priced by the
 * square foot (batts) is as thick as its material says, else its stated R over its R per inch.
 * `lowerBound` allows for whole units: a bag count is rounded up, so the last bag may be partly
 * used; the cavity check uses it so one whole bag on a tiny area is never "overfilled".
 */
export function addedThickness(
  option: PricedOption,
  area: AreaInput,
  snapshot: PricingSnapshot,
  coefficients?: CoefficientSet | null,
  opts: ThicknessBound = {},
): number {
  return insulationLines(option, area.id, snapshot).reduce((a, line) => a + lineThickness(line, option, area, snapshot, coefficients, opts), 0);
}

function lineThickness(
  line: PricedLine,
  option: PricedOption,
  area: AreaInput,
  snapshot: PricingSnapshot,
  coefficients: CoefficientSet | null | undefined,
  opts: ThicknessBound,
): number {
  if (!(area.sqft > 0)) return 0;
  const product = snapshot.products.find((p) => p.code === line.product)!;
  const mat =
    snapshot.materials.find((m) => m.id === line.materialId) ??
    snapshot.materials.find((m) => m.productCode === line.product && !m.jobType && !m.rValue);
  if (line.unit === 'bag' || line.unit === 'board_ft') {
    const slack = opts.lowerBound ? (line.unit === 'bag' ? 1 : 0.05) : opts.upperBound && line.unit === 'board_ft' ? -0.05 : 0;
    const installed = Math.max(0, line.qty - slack) / wasteOf(line, area, coefficients);
    const coverage = line.unit === 'bag' ? (mat?.coverageSqftIn ?? 0) : 1;
    return (installed * coverage) / area.sqft;
  }
  const thick = mat?.thicknessIn;
  if (typeof thick === 'number' && thick > 0) return thick;
  const item = workItems(option).find((i) => i.areaId === area.id && i.description.toLowerCase().includes(product.label.toLowerCase()));
  const r = item ? statedR(item.description) : null;
  const existingR = removesExisting(option, area.id) ? 0 : area.currentR;
  return r !== null && product.rPerInch && product.rPerInch > 0 ? Math.max(0, r - existingR) / product.rPerInch : 0;
}

/**
 * The R-value the area ends up at in this option: what stays (unless removed) plus what is
 * installed. A sized material (a batt with its own R-value and thickness) adds its rated R;
 * anything else adds its thickness times its product's R per inch.
 */
export function finalR(option: PricedOption, area: AreaInput, snapshot: PricingSnapshot, coefficients?: CoefficientSet | null, opts: ThicknessBound = {}): number {
  let r = removesExisting(option, area.id) ? 0 : area.currentR;
  for (const line of insulationLines(option, area.id, snapshot)) {
    const sized = snapshot.materials.find((m) => m.id === line.materialId);
    if (sized?.rValue && sized.thicknessIn && line.unit === 'sqft') {
      r += sized.rValue;
      continue;
    }
    const rPerInch = snapshot.products.find((p) => p.code === line.product)?.rPerInch ?? 0;
    r += lineThickness(line, option, area, snapshot, coefficients, opts) * rPerInch;
  }
  return r;
}

const fmt = (n: number, d = 2) => (Number.isFinite(n) ? Number(n.toFixed(d)).toString() : String(n));

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * items_add_up (audit S1-F2): the items printed under an option add up to the total printed under
 * them, in whole dollars as printed (kind "printed") and to the cent (kind "cents").
 */
export function checkItemsAddUp({ priced }: Pick<PricedQuote, 'priced'>): Violation[] {
  const out: Violation[] = [];
  for (const o of shownOptions(priced)) {
    const printed = o.customerItems.reduce((a, i) => a + printedDollars(i.price), 0);
    if (printed !== printedDollars(o.price)) {
      out.push({
        invariant: 'items_add_up',
        kind: 'printed',
        tier: o.tier,
        areaId: null,
        detail: `items print ${o.customerItems.map((i) => dollarsText(i.price)).join(' + ')} = ${dollarsText(printed)} under a ${dollarsText(o.price)} total`,
      });
    }
    const cents = o.customerItems.reduce((a, i) => a + Math.round(i.price * 100), 0);
    if (cents !== Math.round(o.price * 100)) {
      out.push({ invariant: 'items_add_up', kind: 'cents', tier: o.tier, areaId: null, detail: `items add to ${fmt(cents / 100)} for a ${fmt(o.price)} price` });
    }
  }
  return out;
}

/**
 * same_work_same_price (audit S1-F3, OD2): the same work (the same item in the same area) costs the
 * same in every option that shows it. Each option whose printed price for it differs from the
 * first option showing it is one violation; the kind is the scope (removal, insulation, air sealing).
 */
export function checkSameWorkSamePrice({ priced }: Pick<PricedQuote, 'priced'>): Violation[] {
  const out: Violation[] = [];
  const first = new Map<string, { tier: Tier; price: number }>();
  for (const o of shownOptions(priced)) {
    for (const item of workItems(o)) {
      const sig = workSignature(item);
      const seen = first.get(sig);
      if (!seen) {
        first.set(sig, { tier: o.tier, price: item.price });
        continue;
      }
      if (printedDollars(item.price) !== printedDollars(seen.price)) {
        out.push({
          invariant: 'same_work_same_price',
          kind: workScope(item.description),
          tier: o.tier,
          areaId: item.areaId,
          detail: `"${item.description}" is ${dollarsText(seen.price)} in ${seen.tier} and ${dollarsText(item.price)} in ${o.tier}`,
        });
      }
    }
  }
  return out;
}

/**
 * options_step_up (audit S1-F7, OD6): the options shown step up. An option shown after another must
 * do different work (kind "duplicate_shown" when its work is the same as an option before it) and
 * cost more than the option before it (kind "not_increasing", or "not_increasing_override" when an
 * estimator changed a price or a line in either option).
 */
export function checkOptionsStepUp({ priced }: Pick<PricedQuote, 'priced'>): Violation[] {
  const out: Violation[] = [];
  const shown = shownOptions(priced);
  const work = (o: PricedOption) => workItems(o).map(workSignature).sort().join('\n');
  for (let i = 1; i < shown.length; i++) {
    const hi = shown[i]!;
    const dup = shown.slice(0, i).find((lo) => work(lo) === work(hi));
    if (dup) {
      out.push({
        invariant: 'options_step_up',
        kind: 'duplicate_shown',
        tier: hi.tier,
        areaId: null,
        detail: `${hi.tier} (${dollarsText(hi.price)}) does the same work as ${dup.tier} (${dollarsText(dup.price)})`,
      });
      continue;
    }
    const lo = shown[i - 1]!;
    if (printedDollars(hi.price) <= printedDollars(lo.price)) {
      const touched = lo.isOverridden || hi.isOverridden || lo.hasLineOverrides || hi.hasLineOverrides;
      out.push({
        invariant: 'options_step_up',
        kind: touched ? 'not_increasing_override' : 'not_increasing',
        tier: hi.tier,
        areaId: null,
        detail: `${hi.tier} ${dollarsText(hi.price)} does not cost more than ${lo.tier} ${dollarsText(lo.price)}`,
      });
    }
  }
  return out;
}

const TIER_RANK: Record<string, number> = { good: 0, better: 1, best: 2 };

/**
 * options_step_up, kinds wrongly_hidden and none_shown (review A F8, OD6): an option priced but not
 * shown to the customer is hidden for a reason the customer can see: it installs nothing (no work
 * item); it does the same work (the same items, the same materials) as another option for as much
 * or more (on a tie, the lower tier is the one kept); or the next option shown above it costs no
 * more. Read from what the customer would read, not from the engine's own rule. And when any option
 * has work, at least one is shown. Needs `all` (the showAll result).
 */
export function checkHiddenRightly({ priced, snapshot, all }: Pick<PricedQuote, 'priced' | 'snapshot' | 'all'>): Violation[] {
  if (!all) return [];
  const out: Violation[] = [];
  const shown = shownOptions(priced);
  const shownTiers = new Set(shown.map((o) => o.tier));
  const hasWork = (o: PricedOption) => workItems(o).length > 0;
  const work = (o: PricedOption) =>
    [
      ...workItems(o).map(workSignature),
      ...o.lines.filter((l) => l.kind === 'material' && l.areaId !== null && !!snapshot.products.find((p) => p.code === l.product)?.isRBearing).map((l) => `${l.areaId}|${l.product}|${l.materialId}`),
    ]
      .sort()
      .join('\n');
  const rank = (o: PricedOption) => TIER_RANK[o.tier] ?? 3;
  for (const o of all.options) {
    if (shownTiers.has(o.tier) || !hasWork(o)) continue;
    const price = printedDollars(o.price);
    const duplicate = all.options.some(
      (d) => d.tier !== o.tier && hasWork(d) && work(d) === work(o) && (printedDollars(d.price) < price || (printedDollars(d.price) === price && rank(d) < rank(o))),
    );
    const above = shown.filter((s) => rank(s) > rank(o)).sort((a, b) => rank(a) - rank(b))[0];
    const noStepUp = above !== undefined && printedDollars(above.price) <= price;
    if (!duplicate && !noStepUp) {
      out.push({
        invariant: 'options_step_up',
        kind: 'wrongly_hidden',
        tier: o.tier,
        areaId: null,
        detail: `${o.tier} (${dollarsText(o.price)}) is not shown, but no option does its work for less${above ? ` and ${above.tier} above it costs more (${dollarsText(above.price)})` : ''}`,
      });
    }
  }
  if (shown.length === 0 && all.options.some(hasWork)) {
    out.push({ invariant: 'options_step_up', kind: 'none_shown', tier: null, areaId: null, detail: `no option is shown, though ${all.options.filter(hasWork).map((o) => o.tier).join(', ')} has work` });
  }
  return out;
}

/**
 * options_step_up, kind ends_below_existing (review A F9): an option that takes out the insulation
 * already in an area, when the estimator did not say it must go (removalNeeded), ends that area at
 * or above the R it has. Paying to remove R-38 and get R-30 back is no step up.
 */
export function checkEndsAtOrAbove({ input, priced, snapshot, coefficients }: PricedQuote): Violation[] {
  const out: Violation[] = [];
  for (const o of shownOptions(priced)) {
    for (const a of input.areas) {
      if (a.removalNeeded || !(a.currentR > 0) || !removesExisting(o, a.id)) continue;
      const r = finalR(o, a, snapshot, coefficients, { upperBound: true });
      if (r < a.currentR - R_TOLERANCE) {
        out.push({
          invariant: 'options_step_up',
          kind: 'ends_below_existing',
          tier: o.tier,
          areaId: a.id,
          detail: `${o.tier} removes ${a.name}'s R-${fmt(a.currentR, 1)} and ends at R-${fmt(r, 1)}`,
        });
      }
    }
  }
  return out;
}

const JOB_WORDS: Record<JobType, RegExp> = {
  attic: /\battics?\b/i,
  walls: /\bwalls?\b/i,
  crawlspace: /\bcrawl\s?spaces?\b/i,
  rim_joist: /\brim\b/i,
  garage: /\bgarages?\b/i,
  commercial: /\bcommercial\b/i,
};
const PROMISES_CODE = /\bcode\b/i;
const PROMISES_FULL_CAVITY = /\b(full|whole|entire) cavit(y|ies)\b|\bfills? the (\d+(\.\d+)? in )?cavit(y|ies)\b/i;
/** A cavity with less room than this left is full: nothing more can be blown, sprayed or laid in (cavity_full). */
const FULL_ROOM_IN = 0.5;
const PROMISES_REMOVAL = /\bremov/i;
const PROMISES_AIR_SEALING = /\bair[\s-]?seal/i;

/** Spray foam seals air as it insulates, so it keeps an air-sealing promise on its own. */
const SEALS_AIR = new Set(['air_sealing', 'ocsf', 'ccsf']);

/** True when the option air seals the area: air sealing priced, or spray foam installed. */
export function airSealed(option: PricedOption, areaId: string): boolean {
  return option.lines.some((l) => l.areaId === areaId && l.kind === 'material' && !!l.product && SEALS_AIR.has(l.product)) ||
    option.lines.some((l) => l.areaId === areaId && l.product === 'air_sealing');
}

/** The areas a sentence is about: the job types it names, else every area of the quote. */
function areasNamed(text: string, areas: AreaInput[]): AreaInput[] {
  const named = areas.filter((a) => JOB_WORDS[a.jobType].test(text));
  return named.length ? named : areas;
}

/**
 * labels_match_work (audit S1-F7): an option's title and bullets promise only work that is priced.
 *  - code_below_code: it says "code" (a "to Code" title, "Brings your attic to current code
 *    R-value") but an area it is about ends below that job type's code minimum.
 *  - removal_not_priced: it says remove/removed but no area it is about has removal priced.
 *  - air_sealing: it says air seal/air sealing but no area it is about is air sealed (air sealing
 *    priced, or spray foam, which seals as it insulates: "Air seal and insulate in one step").
 *  - full_cavity_not_filled: it, or a work item, says the cavity is filled ("Fills the full
 *    cavity", "fills the 3.5 in cavity") but a cavity it is about is left partly empty.
 *  - qty_below_stated_r: a work item states an R-value ("… to R-12.6 …") that the quantity priced
 *    for its area does not reach (the estimator's bag count, R3).
 *  - product_not_installed: a work item states an R-value ("… to R-0 …") in an area where every
 *    R-bearing line it could be about has a quantity of 0: nothing is installed (review A F4).
 *  - area_not_covered: a work item for a material priced by the square foot (batts, air sealing)
 *    states an area ("800 sq ft") that its quantity, the waste taken out, does not cover, or covers
 *    more than (review A F3; within 1%, and the rounding of the area as printed).
 * Work items are about their own area.
 * A sentence is about the areas whose job type it names, else every area in the quote.
 */
export function checkLabelsMatchWork({ input, priced, snapshot, coefficients }: PricedQuote): Violation[] {
  const out: Violation[] = [];
  for (const o of shownOptions(priced)) {
    const texts = [o.label, ...o.bullets];
    const seen = new Set<string>();
    const add = (kind: string, areaId: string | null, detail: string) => {
      const key = `${kind}|${areaId}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ invariant: 'labels_match_work', kind, tier: o.tier, areaId, detail });
    };
    for (const text of texts) {
      const about = areasNamed(text, input.areas);
      if (PROMISES_CODE.test(text)) {
        for (const a of about) {
          const code = snapshot.codeRequirements.find((c) => c.jobType === a.jobType)?.minR;
          if (code === undefined) continue;
          const r = finalR(o, a, snapshot, coefficients);
          if (r < code - R_TOLERANCE) add('code_below_code', a.id, `"${text}" but ${a.name} ends at R-${fmt(r, 1)}, below the R-${code} code minimum`);
        }
      }
      if (PROMISES_REMOVAL.test(text) && !about.some((a) => removesExisting(o, a.id))) {
        add('removal_not_priced', about.length === 1 ? about[0]!.id : null, `"${text}" but no removal is priced`);
      }
      if (PROMISES_AIR_SEALING.test(text) && !about.some((a) => airSealed(o, a.id))) {
        add('air_sealing', about.length === 1 ? about[0]!.id : null, `"${text}" but no air sealing is priced`);
      }
      if (PROMISES_FULL_CAVITY.test(text)) {
        for (const a of about) {
          const left = roomLeft(o, a, snapshot, coefficients);
          if (left !== null) add('full_cavity_not_filled', a.id, `"${text}" but ${a.name} has ${fmt(left, 2)} in of its ${fmt(cavityDepth(a)!, 2)} in cavity left empty`);
        }
      }
    }
    for (const item of workItems(o)) {
      const a = input.areas.find((x) => x.id === item.areaId);
      if (!a) continue;
      // What an item states it installs is what its quantity installs (R3).
      const stated = statedR(item.description);
      const insulating = insulationLines(o, a.id, snapshot);
      if (stated !== null && insulating.length > 0 && insulating.every((l) => !(l.qty > 0))) {
        add('product_not_installed', a.id, `"${item.description}" but the quantity priced is 0`);
      } else if (stated !== null && insulating.length > 0) {
        const r = finalR(o, a, snapshot, coefficients, { upperBound: true });
        if (r < stated - R_TOLERANCE) add('qty_below_stated_r', a.id, `"${item.description}" but the quantity priced gives ${a.name} R-${fmt(r, 1)}`);
      }
      if (PROMISES_FULL_CAVITY.test(item.description)) {
        const left = roomLeft(o, a, snapshot, coefficients);
        if (left !== null) add('full_cavity_not_filled', a.id, `"${item.description}" but ${fmt(left, 2)} in of the ${fmt(cavityDepth(a)!, 2)} in cavity is left empty`);
      }
      const sqft = statedSqft(item.description);
      const byTheFoot = sqftLines(o, a.id, item.description, snapshot);
      if (sqft !== null && byTheFoot.length === 1) {
        const covered = byTheFoot[0]!.qty / wasteOf(byTheFoot[0]!, a, coefficients);
        const tolerance = Math.max(0.01 * Math.max(sqft, covered), sqft < 10 ? 0.051 : 0.51);
        if (Math.abs(covered - sqft) > tolerance) add('area_not_covered', a.id, `"${item.description}" but the quantity priced covers ${fmt(covered, 1)} sq ft`);
      }
    }
  }
  return out;
}

/**
 * The material lines priced by the square foot that a work item describes: air sealing for an air
 * sealing item, else the R-bearing ones (batts).
 */
function sqftLines(o: PricedOption, areaId: string, description: string, snapshot: PricingSnapshot): PricedLine[] {
  const scope = workScope(description);
  if (scope === 'removal') return [];
  const lines = scope === 'air_sealing' ? o.lines.filter((l) => l.areaId === areaId && l.kind === 'material' && l.product === 'air_sealing') : insulationLines(o, areaId, snapshot);
  return lines.filter((l) => l.unit === 'sqft');
}

/**
 * The inches of an area's cavity an option leaves empty, when that breaks a promise of a full
 * cavity; null when the cavity is full (or the area has none). With insulation added, full is to
 * within rounding; with nothing added, what is there leaves less room than can be filled.
 */
function roomLeft(o: PricedOption, a: AreaInput, snapshot: PricingSnapshot, coefficients: CoefficientSet | null | undefined): number | null {
  const depth = cavityDepth(a);
  if (depth === null) return null;
  const added = addedThickness(o, a, snapshot, coefficients, { upperBound: true });
  const left = depth - existingThickness(a, o) - added;
  return left > (added > 0 ? THICKNESS_TOLERANCE_IN : FULL_ROOM_IN) ? left : null;
}

/**
 * cavity_not_overfilled (audit S1-F4, S1-F5, S1-F6, OD5): what an option installs fits in the
 * cavity with what is already there (unless the option removes it). The cavity is the depth
 * entered (kind "overfilled") or, for walls with none, a 2x4 wall (kind "overfilled_no_depth").
 * Areas with no cavity (open attic floors) and options that add nothing are not checked.
 */
export function checkCavityNotOverfilled({ input, priced, snapshot, coefficients }: PricedQuote): Violation[] {
  const out: Violation[] = [];
  for (const o of shownOptions(priced)) {
    for (const a of input.areas) {
      const depth = cavityDepth(a);
      if (depth === null) continue;
      const added = addedThickness(o, a, snapshot, coefficients, { lowerBound: true });
      if (!(added > 0)) continue;
      const existing = existingThickness(a, o);
      if (existing + added > depth + THICKNESS_TOLERANCE_IN) {
        const priced = addedThickness(o, a, snapshot, coefficients);
        out.push({
          invariant: 'cavity_not_overfilled',
          kind: a.depthIn === null ? 'overfilled_no_depth' : 'overfilled',
          tier: o.tier,
          areaId: a.id,
          detail: `${a.name}: ${fmt(existing, 1)} in already there + ${fmt(priced, 1)} in added in a ${fmt(depth, 2)} in cavity${a.depthIn === null ? ' (no depth entered: a 2x4 wall)' : ''}`,
        });
      }
    }
  }
  return out;
}

/**
 * finite_amounts (audit "checked and correct"): no blank, infinite or negative amount anywhere in
 * an option: price, costs, hours, days, financing, every line and every customer item. A price
 * adjustment line (OD3) may be negative; nothing else may. A work item printed at $0 is work sold
 * for nothing (kind zero_work_item, review A F4).
 */
export function checkFiniteAmounts({ priced }: Pick<PricedQuote, 'priced'>): Violation[] {
  const out: Violation[] = [];
  const check = (tier: Tier, areaId: string | null, what: string, n: unknown, mayBeNegative = false) => {
    if (typeof n !== 'number' || !Number.isFinite(n)) out.push({ invariant: 'finite_amounts', kind: 'not_finite', tier, areaId, detail: `${what} is ${String(n)}` });
    else if (n < 0 && !mayBeNegative) out.push({ invariant: 'finite_amounts', kind: 'negative', tier, areaId, detail: `${what} is ${n}` });
  };
  for (const o of priced.options) {
    for (const k of ['price', 'modelPrice', 'adjustedPrice', 'materialCost', 'laborHours', 'laborCost', 'driveCost', 'disposalCost', 'directCost', 'loadedCost', 'crewDays'] as const) {
      check(o.tier, null, k, o[k]);
    }
    check(o.tier, null, 'marginPct', o.marginPct, true);
    if (o.financing) check(o.tier, null, 'financing.monthly', o.financing.monthly);
    for (const l of o.lines) {
      check(o.tier, l.areaId, `line "${l.description}" cost`, l.cost, l.kind === 'discount');
      check(o.tier, l.areaId, `line "${l.description}" qty`, l.qty);
      if (l.hours !== null) check(o.tier, l.areaId, `line "${l.description}" hours`, l.hours);
    }
    for (const i of o.customerItems) {
      check(o.tier, i.areaId, `item "${i.description}"`, i.price, itemKind(i) === 'adjustment');
      if (itemKind(i) === 'work' && Number.isFinite(i.price) && printedDollars(i.price) === 0) {
        out.push({ invariant: 'finite_amounts', kind: 'zero_work_item', tier: o.tier, areaId: i.areaId, detail: `item "${i.description}" is $0` });
      }
    }
  }
  return out;
}

/** Every engine-level rule on one priced quote. */
export function checkPricedQuote(q: PricedQuote): Violation[] {
  return [
    ...checkItemsAddUp(q),
    ...checkSameWorkSamePrice(q),
    ...checkOptionsStepUp(q),
    ...checkHiddenRightly(q),
    ...checkEndsAtOrAbove(q),
    ...checkLabelsMatchWork(q),
    ...checkCavityNotOverfilled(q),
    ...checkFiniteAmounts(q),
  ];
}
