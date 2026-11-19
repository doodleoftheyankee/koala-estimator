import { coeff, findCoefficient } from './coefficients';
import { ceilHalf, money, monthlyPayment, priceStep, roundUpTo } from './finance';
import { cavityDepth, DEFAULT_WALL_CAVITY_IN, existingThicknessIn, MIN_ROOM_IN } from './rPerInch';
import type {
  AreaInput,
  LineOverride,
  CoefficientSet,
  CrewConfig,
  CustomerItem,
  EstimateInput,
  JobType,
  LineKind,
  MaterialConfig,
  PricedEstimate,
  PricedLine,
  PricedOption,
  PricingSnapshot,
  PricingWarning,
  ProductCode,
  ProductConfig,
  Tier,
  TierTemplate,
} from './types';
import { lineKey, PricingConfigError, TIERS } from './types';

export interface PriceEstimateOptions {
  /**
   * Return every priced option, including those the customer is not shown (OD6). For the pricing
   * math and its tests; quotes, the phone and the server use the default (only what is shown).
   */
  showAll?: boolean;
}

/**
 * Prices an estimate. Pure and deterministic: same input + snapshot + coefficients => same output.
 *
 * Every option's customer items are whole dollars and add up to its price (OD4): each work item is
 * priced from its own cost, so the same work costs the same in every option (OD2); the rest of the
 * model price is a "Travel and setup" line, the minimum job top-up a "Minimum job charge" line, and
 * an estimator's price a "Price adjustment" line (OD3).
 *
 * Options that duplicate another, or do not step up from the one below, are not returned unless
 * opts.showAll is set; each one gets an 'option_hidden' warning, so the estimator is told (OD6).
 *
 * Throws PricingConfigError when the configuration is unusable (missing crew, product,
 * coefficient, nonsensical margin). Throws RangeError for invalid input. Never returns NaN.
 */
export function priceEstimate(
  input: EstimateInput,
  snapshot: PricingSnapshot,
  coeffs: CoefficientSet,
  opts: PriceEstimateOptions = {},
): PricedEstimate {
  validateSnapshot(snapshot);
  input.areas.forEach(validateArea);

  const warnings: PricingWarning[] = [];
  const crew = pickCrew(snapshot, input.crewId);
  const priced: PricedOption[] = [];

  const overrides = input.lineOverrides ?? {};
  const hasLineOverrides = Object.keys(overrides).length > 0;
  // Pure-model options: the price the learning loop and approval limits compare against, and the
  // model values a line override is scaled from.
  const pure = new Map<Tier, PricedOption>();
  if (hasLineOverrides) {
    for (const tier of TIERS) {
      const p = priceTier(tier, input, snapshot, coeffs, crew, [], {});
      if (p) pure.set(tier, p);
    }
  }
  // The hours an estimator's hours are scaled from: each tier's install hours for the quantities
  // it prices (its model hours, unless a quantity was changed). Bags typed for every option are the
  // same work in each, so they keep the same hours and the same price (OD2).
  const base = new Map<Tier, PricedOption>(pure);
  const qtyOnly = Object.fromEntries(Object.entries(overrides).filter(([, o]) => isNum(o.qty)).map(([key, o]) => [key, { ...o, hours: null }]));
  if (Object.keys(qtyOnly).length > 0) {
    for (const tier of TIERS) {
      const b = priceTier(tier, input, snapshot, coeffs, crew, [], overridesForTier(qtyOnly, tier, pure, pure));
      if (b) base.set(tier, b);
    }
  }
  for (const tier of TIERS) {
    const ov = hasLineOverrides ? overridesForTier(overrides, tier, pure, base) : overrides;
    const option = priceTier(tier, input, snapshot, coeffs, crew, warnings, ov);
    if (!option) continue;
    if (hasLineOverrides) option.modelPrice = pure.get(tier)?.adjustedPrice ?? option.adjustedPrice;
    priced.push(option);
  }

  const options = opts.showAll ? priced : shownOptions(priced, warnings);
  // Good should cost less than better, better less than best. If the configured products and
  // costs say otherwise, the estimator needs to know before a customer sees it. (Shown options
  // always step up, so this only fires with showAll.)
  for (let i = 1; i < options.length; i++) {
    const lo = options[i - 1]!;
    const hi = options[i]!;
    if (lo.price > hi.price) {
      warnings.push({
        code: 'tier_price_order',
        areaId: null,
        tier: hi.tier,
        message: `${capitalize(lo.tier)} (${usd(lo.price)}) costs more than ${hi.tier} (${usd(hi.price)}). Check material costs or the tier setup with the office.`,
      });
    }
  }
  return { options, warnings, crewId: crew.id };
}

// ---------------------------------------------------------------------------
// Which options the customer is shown (OD6)
// ---------------------------------------------------------------------------

/**
 * What an option does, as a string: every area line it prices, with the material and the quantity
 * of each material line (an R-19 batt and an R-30 batt over the same floor are not the same work:
 * review A F5). Two options with the same signature do the same work for the customer (hours and
 * travel follow from the work).
 */
export function workSignature(option: Pick<PricedOption, 'lines'>): string {
  return option.lines
    .filter((l) => l.key !== null)
    .map((l) => (l.kind === 'material' ? `${l.key}=${l.materialId}:${l.qty}` : l.key!))
    .sort()
    .join(';');
}

/** True when `higher` is a real step up from `lower`: different work, for at least $1 more. */
export function stepUp(lower: Pick<PricedOption, 'lines' | 'price'>, higher: Pick<PricedOption, 'lines' | 'price'>): boolean {
  return workSignature(lower) !== workSignature(higher) && higher.price >= lower.price + 1;
}

/**
 * OD6. An option that does the same work as another is shown once, at the lower price (the lower
 * tier on a tie). Then, from the top down, an option is shown only when the next shown option up
 * costs more: an option that costs as much as one that does more is no choice for the customer.
 * Each option left out gets an 'option_hidden' warning. At least one option with work is always
 * shown; an option the estimator emptied (a quantity of 0 on all its work) never is (F4).
 */
function shownOptions(options: PricedOption[], warnings: PricingWarning[]): PricedOption[] {
  const hidden = new Set<Tier>();
  // An option the estimator emptied (a quantity of 0 on all its work) sells nothing (F4).
  for (const o of options) {
    if (o.customerItems.some((i) => i.kind === 'work')) continue;
    hidden.add(o.tier);
    warnings.push({
      code: 'option_hidden',
      areaId: null,
      tier: o.tier,
      message: `${capitalize(o.tier)} is not shown to the customer: it installs nothing. Change the quantity in Details to show it.`,
    });
  }
  for (let i = 0; i < options.length; i++) {
    for (let j = i + 1; j < options.length; j++) {
      const a = options[i]!;
      const b = options[j]!;
      if (hidden.has(a.tier) || hidden.has(b.tier) || workSignature(a) !== workSignature(b)) continue;
      const [drop, keep] = b.price >= a.price ? [b, a] : [a, b];
      hidden.add(drop.tier);
      const price =
        drop.price === keep.price ? '' : ` for ${drop.price > keep.price ? 'more' : 'less'} (${usd(drop.price)} against ${usd(keep.price)})`;
      warnings.push({
        code: 'option_hidden',
        areaId: null,
        tier: drop.tier,
        message: `${capitalize(drop.tier)} is not shown to the customer: it is the same work as ${capitalize(keep.tier)}${price}.${drop.isOverridden ? ' Change its price or its work to show it.' : ''}`,
      });
    }
  }
  let above: PricedOption | null = null;
  for (let i = options.length - 1; i >= 0; i--) {
    const o = options[i]!;
    if (hidden.has(o.tier)) continue;
    if (above && !stepUp(o, above)) {
      hidden.add(o.tier);
      const same = o.price === above.price;
      warnings.push({
        code: 'option_hidden',
        areaId: null,
        tier: o.tier,
        message: `${capitalize(o.tier)} is not shown to the customer: it costs ${same ? 'the same as' : `${usd(o.price)}, more than`} ${capitalize(above.tier)} (${usd(above.price)}), the next option up.${o.isOverridden ? ' Change its price to show it.' : ''}`,
      });
      continue;
    }
    above = o;
  }
  return options.filter((o) => !hidden.has(o.tier));
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSnapshot(s: PricingSnapshot): void {
  const st = s.settings;
  const bad = (msg: string) => {
    throw new PricingConfigError(msg);
  };
  if (!(st.targetMarginPct >= 0 && st.targetMarginPct < 0.95)) bad('target margin must be in [0, 0.95)');
  if (!(st.floorMarginPct >= 0 && st.floorMarginPct <= st.targetMarginPct + 1e-9))
    bad('floor margin must be between 0 and the target margin');
  if (!(st.overheadPct >= 0 && st.overheadPct <= 3)) bad('overhead must be in [0, 3]');
  if (!(st.minimumJobPrice >= 0)) bad('minimum job price must be >= 0');
  if (!(st.priceRounding >= 0)) bad('price rounding must be >= 0');
  if (!(st.productiveHoursPerDay > 0 && st.productiveHoursPerDay <= 24)) bad('productive hours/day must be in (0, 24]');
  if (!(st.vehicleCostPerTrip >= 0)) bad('vehicle cost per trip must be >= 0');
  if (!(st.disposalCostPerSqft >= 0)) bad('disposal cost must be >= 0');
  if (!(st.financing.termMonths > 0) || !(st.financing.apr >= 0 && st.financing.apr < 1))
    bad('financing APR must be in [0,1) and term > 0');
  if (s.crews.length === 0) bad('no active crews configured');
  for (const c of s.crews) {
    if (!(c.size >= 1) || !(c.blendedHourlyCost >= 0)) bad(`crew ${c.name} has invalid size or rate`);
  }
  for (const m of s.materials) {
    if (!(m.costPerUnit >= 0)) bad(`material ${m.name} has a negative cost`);
    if (m.unit === 'bag' && !(m.coverageSqftIn && m.coverageSqftIn > 0))
      bad(`material ${m.name} is sold by the bag but has no coverage`);
  }
}

function validateArea(a: AreaInput): void {
  const fin = (n: number) => Number.isFinite(n);
  if (!fin(a.sqft) || a.sqft <= 0) throw new RangeError(`area ${a.name}: sqft must be > 0`);
  if (!fin(a.currentR) || a.currentR < 0) throw new RangeError(`area ${a.name}: current R must be >= 0`);
  if (a.targetR !== null && (!fin(a.targetR) || a.targetR <= 0))
    throw new RangeError(`area ${a.name}: target R must be > 0`);
  if (a.depthIn !== null && (!fin(a.depthIn) || a.depthIn <= 0))
    throw new RangeError(`area ${a.name}: depth must be > 0`);
}

function pickCrew(s: PricingSnapshot, crewId: string | null): CrewConfig {
  const crew =
    s.crews.find((c) => c.id === crewId) ?? s.crews.find((c) => c.id === s.defaultCrewId) ?? s.crews[0];
  if (!crew) throw new PricingConfigError('no active crews configured');
  return crew;
}

function product(s: PricingSnapshot, code: ProductCode): ProductConfig {
  const p = s.products.find((x) => x.code === code);
  if (!p) throw new PricingConfigError(`product ${code} is not configured`);
  return p;
}

/** A product's general material: the default row, not one for a single job type and not a size. */
const isGeneral = (m: MaterialConfig) => !m.jobType && !(m.rValue && m.thicknessIn);

/**
 * The material a product is priced with in a job type: the product's material for that job type
 * (dense-pack wall cellulose), else its general material. Sizes (batts) are picked by battFor.
 */
function material(s: PricingSnapshot, code: ProductCode, jobType?: JobType): MaterialConfig | null {
  const of = s.materials.filter((m) => m.productCode === code && !(m.rValue && m.thicknessIn));
  return (jobType ? of.find((m) => m.jobType === jobType) : undefined) ?? of.find(isGeneral) ?? null;
}

function requireMaterial(s: PricingSnapshot, code: ProductCode, jobType: JobType): MaterialConfig {
  const m = material(s, code, jobType);
  if (!m) throw new PricingConfigError(`no default material for ${code}`);
  return m;
}

/** A product's sizes (batts) usable in a job type, thinnest R first. */
function sizesOf(s: PricingSnapshot, code: ProductCode, jobType: JobType): MaterialConfig[] {
  return s.materials
    .filter((m) => m.productCode === code && m.rValue && m.thicknessIn && (!m.jobType || m.jobType === jobType))
    .sort((a, b) => a.rValue! - b.rValue! || a.thicknessIn! - b.thicknessIn!);
}

/**
 * The batt for an area (OD8, S1-F6): of the sizes that fit the room in the cavity (any size when
 * there is no cavity), the one with the least R that still reaches the R needed; when none
 * reaches it, the one with the most R that fits. Null when no size fits.
 */
function battFor(sizes: MaterialConfig[], addedR: number, room: number | null): MaterialConfig | null {
  const fits = sizes.filter((m) => room === null || m.thicknessIn! <= room + THICKNESS_TOLERANCE_IN);
  if (fits.length === 0) return null;
  return fits.find((m) => m.rValue! >= addedR - 1e-9) ?? fits.reduce((a, b) => (b.rValue! > a.rValue! || (b.rValue === a.rValue && b.thicknessIn! < a.thicknessIn!) ? b : a));
}

/** Room for rounding a thickness (insulation is described to 0.1 in). */
const THICKNESS_TOLERANCE_IN = 0.05;

export function codeMinimumR(s: PricingSnapshot, jobType: AreaInput['jobType']): number | null {
  return s.codeRequirements.find((c) => c.jobType === jobType)?.minR ?? null;
}

// ---------------------------------------------------------------------------
// Tier pricing
// ---------------------------------------------------------------------------

type Scope = 'removal' | 'primary' | 'air_sealing';

interface ScopeGroup {
  areaId: string;
  areaName: string;
  scope: Scope;
  description: string;
  cost: number;
}

/** What one option does in one area, for its title and bullets (L15: words only for work priced). */
interface AreaWork {
  area: AreaInput;
  tpl: TierTemplate;
  removal: boolean;
  /**
   * The template's own product added insulation; finalR is the R the area ends at (null: no R
   * product); fillsCavity says whether it fills the cavity (null: no cavity, or no R product).
   */
  primary: { finalR: number | null; fillsCavity: boolean | null; partial: boolean } | null;
  airSealing: boolean;
  /** The air sealing priced covers only part of the area (an estimator's quantity, F3). */
  airSealingPartial: boolean;
  /** The estimator set a product's quantity to 0 here: nothing of it is installed (F4). */
  zeroed: boolean;
}

function priceTier(
  tier: Tier,
  input: EstimateInput,
  s: PricingSnapshot,
  k: CoefficientSet,
  crew: CrewConfig,
  warnings: PricingWarning[],
  ov: Record<string, LineOverride>,
): PricedOption | null {
  const templates: TierTemplate[] = [];
  for (const area of input.areas) {
    const tpl = s.tierTemplates.find((t) => t.jobType === area.jobType && t.tier === tier);
    if (!tpl) {
      warnings.push({
        code: 'no_template',
        areaId: area.id,
        tier,
        message: `No ${tier} option is set up for ${area.jobType}; ${tier} was not offered.`,
      });
      return null;
    }
    templates.push(tpl);
  }

  const lines: PricedLine[] = [];
  const groups: ScopeGroup[] = [];
  const works: AreaWork[] = [];
  let removalSqft = 0;

  input.areas.forEach((area, i) => {
    const tpl = templates[i]!;
    const access = coeff(k, 'access_mult', { accessLevel: area.accessLevel });
    const hasExisting = area.currentR > 0 || !!area.existingMaterial;
    let removal = area.removalNeeded || (tpl.includeRemoval && hasExisting);
    let primary: ReturnType<typeof priceProductScope> | undefined;
    if (removal && !area.removalNeeded) {
      // The option's own removal (the estimator did not require it) never leaves the customer with
      // less R than they have: the option keeps what is there instead (review A F9).
      const trial: PricingWarning[] = [];
      const after = priceProductScope(area, tpl, true, s, k, access, crew, tier, trial, ov);
      const endsAt = after?.finalR ?? 0;
      if (endsAt < area.currentR - 1e-9) {
        removal = false;
        warnings.push({
          code: 'removal_kept',
          areaId: area.id,
          tier,
          message: `${area.name}: ${capitalize(tier)} would remove the R-${fmtR(area.currentR)} there and end at R-${fmtR(endsAt)}, so it keeps what is there.`,
        });
      } else {
        primary = after;
        warnings.push(...trial);
      }
    }
    const work: AreaWork = { area, tpl, removal, primary: null, airSealing: false, airSealingPartial: false, zeroed: false };
    works.push(work);

    if (removal) {
      const hours =
        (findCoefficient(k, 'setup_hours', { product: 'removal' })?.value ?? 0) +
        area.sqft * coeff(k, 'removal_hrs_per_sqft', { jobType: area.jobType }) * access;
      const line = laborLine(area.id, 'removal', 'removal', `Remove existing insulation, ${fmtSqft(area.sqft)} sq ft`, hours, crew, ov);
      lines.push(line);
      removalSqft += area.sqft;
      groups.push({
        areaId: area.id,
        areaName: area.name,
        scope: 'removal',
        description: `Remove and dispose of existing insulation (${fmtSqft(area.sqft)} sq ft)`,
        cost: line.cost + area.sqft * s.settings.disposalCostPerSqft,
      });
    }

    if (primary === undefined) primary = priceProductScope(area, tpl, removal, s, k, access, crew, tier, warnings, ov);
    if (primary?.none) {
      // A quantity of 0: nothing installed, so no item and no words for it; the lines stay so the
      // estimator can change the quantity back in Details (F4).
      lines.push(...primary.lines);
      work.zeroed = true;
    } else if (primary) {
      lines.push(...primary.lines);
      groups.push({ areaId: area.id, areaName: area.name, scope: 'primary', description: primary.description, cost: primary.cost });
      work.primary = { finalR: primary.finalR, fillsCavity: primary.fillsCavity, partial: primary.partial };
      if (tpl.primaryProduct === 'air_sealing') {
        work.airSealing = true;
        work.airSealingPartial = primary.partial;
      }
    }

    if (tpl.includeAirSealing && tpl.primaryProduct !== 'air_sealing') {
      const air = priceAirSealing(area, s, k, access, crew, ov, tier, warnings);
      lines.push(...air.lines);
      if (air.none) work.zeroed = true;
      else {
        groups.push({ areaId: area.id, areaName: area.name, scope: 'air_sealing', description: air.description, cost: air.cost });
        work.airSealing = true;
        work.airSealingPartial = air.partial;
      }
    }
  });

  // An option the estimator emptied (a quantity of 0) is still priced, for the estimator only: it is
  // not shown to the customer (shownOptions), and its lines can be changed back (F4).
  if (groups.length === 0 && !works.some((w) => w.zeroed)) {
    warnings.push({
      code: 'tier_skipped',
      areaId: null,
      tier,
      message: `The ${tier} option has no work to do (every area is already at its target R-value, or its cavity is full).`,
    });
    return null;
  }

  const st = s.settings;
  const materialCost = sum(lines.filter((l) => l.kind === 'material').map((l) => l.cost));
  const laborHours = sum(lines.map((l) => l.hours ?? 0));
  const laborCost = sum(lines.filter((l) => l.kind === 'labor' || l.kind === 'removal').map((l) => l.cost));

  const crewDays = Math.max(0.5, ceilHalf(laborHours / (crew.size * st.productiveHoursPerDay)));
  const trips = Math.ceil(crewDays);
  const driveMinutes = Math.max(0, input.driveMinutesOneWay ?? 0);
  const driveFactor = coeff(k, 'drive_time_factor', {});
  const drivePersonHours = (driveMinutes * 2 * trips * crew.size * driveFactor) / 60;
  const driveCost = money(drivePersonHours * crew.blendedHourlyCost + trips * st.vehicleCostPerTrip);
  lines.push({
    key: null,
    areaId: null,
    kind: 'drive',
    product: null,
    materialId: null,
    description: `Travel: ${trips} trip(s), ${fmtNum(driveMinutes)} min each way, crew of ${crew.size}`,
    qty: trips,
    unit: 'each',
    hours: round2(drivePersonHours),
    unitCost: null,
    cost: driveCost,
    designQty: null,
    modelQty: trips,
    modelHours: round2(drivePersonHours),
    modelCost: driveCost,
    isOverridden: false,
    overrideReason: null,
  });

  const disposalCost = money(removalSqft * st.disposalCostPerSqft);
  if (removalSqft > 0) {
    lines.push({
      key: null,
      areaId: null,
      kind: 'disposal',
      product: 'removal',
      materialId: null,
      description: `Disposal, ${fmtSqft(removalSqft)} sq ft`,
      qty: removalSqft,
      unit: 'sqft',
      hours: null,
      unitCost: st.disposalCostPerSqft,
      cost: disposalCost,
      designQty: removalSqft,
      modelQty: removalSqft,
      modelHours: null,
      modelCost: disposalCost,
      isOverridden: false,
      overrideReason: null,
    });
  }

  const directCost = money(sum(lines.map((l) => l.cost)));
  const loadedCost = money(directCost * (1 + st.overheadPct));
  const step = priceStep(st.priceRounding);
  // The price the costs ask for, and the same after the minimum job price.
  const costPrice = roundUpTo(loadedCost / (1 - st.targetMarginPct), step);
  const adjustedPrice = roundUpTo(Math.max(loadedCost / (1 - st.targetMarginPct), st.minimumJobPrice), step);

  // The estimator's price, in whole dollars. Under $1 it is not a price: it is ignored, and said so.
  const override = input.overrides[tier];
  const typed = override && Number.isFinite(override.price) ? override.price : null;
  const isOverridden = typed !== null && typed >= 1;
  if (override && !isOverridden) {
    warnings.push({
      code: 'override_too_low',
      areaId: null,
      tier,
      message: `${capitalize(tier)} price ${usd(typed ?? 0)} is under $1, so it is not used. The price stays ${usd(adjustedPrice)}.`,
    });
  }
  const price = isOverridden ? Math.round(typed) : adjustedPrice;
  const marginPct = price > 0 ? (price - loadedCost) / price : 0;
  const belowFloor = marginPct < st.floorMarginPct - 1e-9;
  if (isOverridden && belowFloor) {
    warnings.push({
      code: 'override_below_floor',
      areaId: null,
      tier,
      message: `${capitalize(tier)} price ${usd(price)} is below the ${pct(st.floorMarginPct)} floor margin (${pct(marginPct)}). Owner approval required.`,
    });
  }

  const customerItems = customerLines(groups, (1 + st.overheadPct) / (1 - st.targetMarginPct), costPrice, adjustedPrice, price);

  const fin = st.financing;
  const financing =
    fin.show && price > 0
      ? {
          provider: fin.provider,
          apr: fin.apr,
          termMonths: fin.termMonths,
          monthly: Math.ceil(monthlyPayment(price, fin.apr, fin.termMonths)),
        }
      : null;

  const text = optionText(tier, works, s);
  return {
    tier,
    label: text.label,
    bullets: text.bullets,
    lines,
    customerItems,
    materialCost: money(materialCost),
    laborHours: round2(laborHours),
    laborCost: money(laborCost),
    driveCost,
    disposalCost,
    directCost,
    loadedCost,
    modelPrice: adjustedPrice, // replaced by the pure-model price in priceEstimate when lines are overridden
    adjustedPrice,
    price,
    isOverridden,
    hasLineOverrides: lines.some((l) => l.isOverridden),
    overrideReason: isOverridden ? override!.reason : null,
    marginPct: round4(marginPct),
    belowFloor,
    crewDays,
    financing,
  };
}

/**
 * The customer's lines for one option, in whole dollars, adding up to `price` (OD2, OD3, OD4):
 *  - each work item at its own cost x the markup (overhead, then target margin), rounded down to
 *    the dollar, so the same work is the same price in every option;
 *  - "Travel and setup": the rest of the price the costs ask for (drive, trips, the rounding);
 *  - "Minimum job charge": the top-up from that price to the minimum job price;
 *  - "Price adjustment": the estimator's price change, plus or minus.
 */
function customerLines(groups: ScopeGroup[], markup: number, costPrice: number, adjustedPrice: number, price: number): CustomerItem[] {
  const work = groups.map((g) => Math.max(0, Math.floor(money(g.cost * markup) + 1e-9)));
  let travel = costPrice - sum(work);
  // Never happens with real numbers (items round down, the price rounds up); kept so a line can
  // never be negative and the items always add up.
  for (let i = 0; travel < 0 && i < work.length; i++) {
    const big = work.indexOf(Math.max(...work));
    const take = Math.min(work[big]!, -travel);
    work[big]! -= take;
    travel += take;
  }
  const items: CustomerItem[] = groups.map((g, i) => ({
    kind: 'work',
    areaId: g.areaId,
    areaName: g.areaName,
    description: g.description,
    price: work[i]!,
  }));
  const job = (kind: CustomerItem['kind'], description: string, amount: number) => {
    if (amount !== 0) items.push({ kind, areaId: null, areaName: '', description, price: amount });
  };
  job('travel', 'Travel and setup', travel);
  job('minimum', 'Minimum job charge', adjustedPrice - costPrice);
  job('adjustment', 'Price adjustment', price - adjustedPrice);
  return items;
}

/**
 * The option's title and bullets, from the work actually priced (L15). A single area keeps its
 * template's title when everything the template promises is priced (its product, the removal, the
 * air sealing), with "to Code" turned into the R it reaches when that is below code; otherwise the
 * title names only the work priced ("Air Sealing"). Bullets come only from areas with work in the
 * option, and lose what is not priced: removal, the product, code.
 */
function optionText(tier: Tier, works: AreaWork[], s: PricingSnapshot): { label: string; bullets: string[] } {
  const withWork = works.filter((w) => w.removal || w.primary || w.airSealing);
  let bullets = dedupe(withWork.flatMap((w) => areaBullets(w, s)));
  // A sentence holds for every area it is about: the areas whose job type it names, else every
  // area of the quote. "Code" only when each ends at code (a package's 2x4 walls end below R-20);
  // "Fills the full cavity" only when each cavity is full (R6, L23).
  bullets = bullets.filter((b) => !CODE_WORDS.test(b) || !areasAbout(b, works).some((w) => endsBelowCode(w, s)));
  bullets = bullets.filter((b) => !FULL_CAVITY_WORDS.test(b) || areasAbout(b, works).every(cavityFilled));
  if (works.length !== 1) return { label: `${capitalize(tier)} package`, bullets };
  return { label: areaLabel(works[0]!, s), bullets };
}

/** The template promises its product (an R product, or air sealing as the product). */
const promisesProduct = (tpl: TierTemplate) => tpl.primaryProduct !== 'removal';

function keepsPromise(w: AreaWork): boolean {
  const removal = w.tpl.includeRemoval || w.tpl.primaryProduct === 'removal';
  return (!removal || w.removal) && (!promisesProduct(w.tpl) || w.primary !== null) && (!w.tpl.includeAirSealing || w.airSealing);
}

/**
 * True when the area's cavity is full in this option: its product filled it, or, with nothing
 * added, what is there leaves less room than can be filled. An area with no cavity has nothing to fill.
 */
function cavityFilled(w: AreaWork): boolean {
  if (w.primary && w.primary.fillsCavity !== null) return w.primary.fillsCavity;
  const depth = cavityDepth(w.area);
  if (depth === null) return true;
  return depth - (w.removal ? 0 : existingThicknessIn(w.area)) < MIN_ROOM_IN;
}

/** The R an area ends at in an option: what its product brings it to, else what stays there. */
const endsAt = (w: AreaWork): number => w.primary?.finalR ?? (w.removal ? 0 : w.area.currentR);

function endsBelowCode(w: AreaWork, s: PricingSnapshot): boolean {
  const code = codeMinimumR(s, w.area.jobType);
  // Insulation over only part of the area leaves the rest where it was (F3).
  return code !== null && (endsAt(w) < code - 1e-9 || (w.primary?.partial === true && w.area.currentR < code - 1e-9));
}

/** How a sentence names each kind of job ("your attic", "the walls"). */
const JOB_WORDS: Record<JobType, RegExp> = {
  attic: /\battics?\b/i,
  walls: /\bwalls?\b/i,
  crawlspace: /\bcrawl\s?spaces?\b/i,
  rim_joist: /\brim\b/i,
  garage: /\bgarages?\b/i,
  commercial: /\bcommercial\b/i,
};

/** The areas a sentence is about: those whose job type it names, else every area. */
function areasAbout(text: string, works: AreaWork[]): AreaWork[] {
  const named = works.filter((w) => JOB_WORDS[w.area.jobType].test(text));
  return named.length ? named : works;
}

function belowCode(w: AreaWork, s: PricingSnapshot): number | null {
  const finalR = w.primary?.finalR ?? null;
  const code = codeMinimumR(s, w.area.jobType);
  return finalR !== null && code !== null && finalR < code - 1e-9 ? finalR : null;
}

function areaLabel(w: AreaWork, s: PricingSnapshot): string {
  if (keepsPromise(w)) {
    const below = belowCode(w, s);
    return below !== null ? w.tpl.label.replace(/\bto code\b/i, `to R-${fmtR(below)}`) : w.tpl.label;
  }
  const parts: string[] = [];
  if (w.removal) parts.push('Insulation Removal');
  if (w.airSealing) parts.push('Air Sealing');
  if (w.primary && w.tpl.primaryProduct !== 'air_sealing') parts.push(product(s, w.tpl.primaryProduct).label);
  return parts.length ? parts.join(' + ') : 'Nothing installed';
}

const REMOVAL_WORDS = /\bremov/i;
const SEALING_WORDS = /seal|leak|draft|penetration|bypass/i;
const CODE_WORDS = /\bcode\b/i;
const FULL_CAVITY_WORDS = /\b(full|whole|entire) cavit(y|ies)\b|\bfills? the cavit(y|ies)\b/i;
/** A sentence that says every leak is sealed ("Full air sealing", "Every penetration sealed"). */
const ALL_SEALED_WORDS = /\b(full|every|all|complete|whole)\b/i;

function areaBullets(w: AreaWork, s: PricingSnapshot): string[] {
  let out = w.tpl.bullets;
  if (promisesProduct(w.tpl) && w.tpl.primaryProduct !== 'air_sealing' && !w.primary) {
    // The product is not in this option: keep only what is said about the work that is.
    out = out.filter((b) => (w.airSealing && SEALING_WORDS.test(b)) || (w.removal && REMOVAL_WORDS.test(b)));
  }
  if (!w.removal) out = out.filter((b) => !REMOVAL_WORDS.test(b));
  if (belowCode(w, s) !== null || w.primary?.partial) out = out.filter((b) => !CODE_WORDS.test(b));
  if (w.primary?.fillsCavity !== true) out = out.filter((b) => !FULL_CAVITY_WORDS.test(b));
  // Air sealing over part of the area does not seal every leak (F3).
  if (w.airSealingPartial) out = out.filter((b) => !(SEALING_WORDS.test(b) && ALL_SEALED_WORDS.test(b)));
  return out;
}

function priceProductScope(
  area: AreaInput,
  tpl: TierTemplate,
  removal: boolean,
  s: PricingSnapshot,
  k: CoefficientSet,
  access: number,
  crew: CrewConfig,
  tier: Tier,
  warnings: PricingWarning[],
  ov: Record<string, LineOverride>,
): { lines: PricedLine[]; description: string; cost: number; finalR: number | null; fillsCavity: boolean | null; partial: boolean; none: boolean } | null {
  const code = tpl.primaryProduct;
  const p = product(s, code);
  if (code === 'air_sealing') return { ...priceAirSealing(area, s, k, access, crew, ov, tier, warnings), finalR: null, fillsCavity: null };
  if (code === 'removal') return null; // removal is handled as its own scope
  if (!p.isRBearing) throw new PricingConfigError(`${code} cannot be a primary insulation product`);

  const targetR = area.targetR ?? tpl.targetR ?? codeMinimumR(s, area.jobType);
  if (targetR === null) throw new PricingConfigError(`no target R for ${area.jobType} (set a code minimum)`);
  const existingR = removal ? 0 : area.currentR;
  const addedR = targetR - existingR;
  if (addedR <= 0) {
    warnings.push({
      code: 'already_at_target',
      areaId: area.id,
      tier,
      message: `${area.name} is already at R-${fmtNum(existingR)}, which meets R-${fmtNum(targetR)}. No ${p.label.toLowerCase()} added.`,
    });
    return null;
  }

  // The cavity it has to fit in (a wall with no depth is a 2x4 wall, OD5) and the room that the
  // insulation already in it leaves, unless this option removes it first (S1-F5).
  const depth = cavityDepth(area);
  const existingIn = removal ? 0 : existingThicknessIn(area);
  const room = depth === null ? null : Math.max(0, depth - existingIn);
  const cavity = depth === null ? '' : cavityText(area, depth);
  const already = existingIn > 0 && depth !== null ? `, with ${fmtIn(Math.min(existingIn, depth))} in already in it,` : '';
  const full = (why: string) => {
    warnings.push({ code: 'cavity_full', areaId: area.id, tier, message: `${area.name}: ${why}, so ${capitalize(tier)} adds no ${p.label.toLowerCase()}.` });
    return null;
  };
  if (room !== null && room < MIN_ROOM_IN) return full(`${cavity} already holds ${fmtIn(existingIn)} in of insulation`);
  const capped = (why: string) =>
    warnings.push({
      code: 'thickness_capped',
      areaId: area.id,
      tier,
      message: `${area.name}: ${why} (target R-${fmtNum(targetR)}).`,
    });

  const sizes = sizesOf(s, code, area.jobType);
  let mat: MaterialConfig;
  let designQty: number;
  let achievedR: number;
  let thickness: number | null = null;
  let fillsCavity: boolean | null = null;

  if (p.unit === 'sqft' && sizes.length > 0) {
    // Batts: one size, picked by R-value and thickness so it fits (OD8, S1-F6).
    const batt = battFor(sizes, addedR, room);
    if (!batt) return full(`no batt fits the ${fmtIn(room!)} in left in ${cavity}`);
    mat = batt;
    designQty = area.sqft;
    achievedR = existingR + batt.rValue!;
    thickness = batt.thicknessIn!;
    if (batt.rValue! < addedR - 1e-9) {
      capped(room === null ? `the thickest batt is R-${fmtR(batt.rValue!)}` : `the thickest batt that fits ${cavity}${already ? `${already.slice(0, -1)}` : ''} is R-${fmtR(batt.rValue!)}`);
    }
    fillsCavity = room === null ? null : batt.thicknessIn! >= room - THICKNESS_TOLERANCE_IN;
  } else {
    mat = requireMaterial(s, code, area.jobType);
    if (mat.unit === 'board_ft' || mat.unit === 'bag') {
      if (!p.rPerInch || p.rPerInch <= 0) throw new PricingConfigError(`${code} has no R per inch`);
      // A wall blown with loose fill is dense-packed: it always fills the room left (L20, R6).
      const denseFill = mat.unit === 'bag' && room !== null && area.jobType === 'walls';
      thickness = denseFill ? room! : addedR / p.rPerInch;
      if (room !== null && thickness > room) thickness = room;
      achievedR = existingR + thickness * p.rPerInch;
      if (room !== null && achievedR < targetR - 1e-9) capped(`${cavity}${already} only fits R-${fmtR(floorR(achievedR))} of ${p.label.toLowerCase()}`);
      designQty = mat.unit === 'board_ft' ? area.sqft * thickness : (area.sqft * thickness) / mat.coverageSqftIn!;
    } else {
      designQty = area.sqft;
      achievedR = targetR;
    }
  }

  const waste = coeff(k, 'waste_factor', { product: code, jobType: area.jobType });
  const rawQty = designQty * waste;
  const modelQty = mat.unit === 'bag' ? Math.ceil(rawQty - 1e-9) : qty1(rawQty);

  const setup = findCoefficient(k, 'setup_hours', { product: code, jobType: area.jobType })?.value ?? 0;
  // Hours for a number of design units: units x hours per unit x access, multiplied in that order
  // (as before the money stage: another order rounds a half-cent tie the other way, review A F6).
  const perUnit = coeff(k, 'labor_hrs_per_unit', { product: code, jobType: area.jobType });
  const hoursFor = (units: number) => setup + units * perUnit * access;

  let matLine = materialLine(area.id, code, mat, `${mat.name}`, designQty, modelQty, ov);
  // A product sold by the square foot (batts) covers the quantity priced over the waste (F3).
  let covered = area.sqft;
  if (mat.unit === 'sqft') {
    const c = sqftCoverage(area, matLine, waste, tier, p.label.toLowerCase(), warnings, true);
    matLine = c.line;
    covered = c.covered;
  }
  if (!(matLine.qty > 0)) {
    // The estimator's quantity is 0: nothing is installed, so no install hours either (unless they
    // typed hours), and the option says nothing of this product (F4).
    warnings.push({ code: 'product_zero', areaId: area.id, tier, message: `${area.name}: ${capitalize(tier)} installs no ${p.label.toLowerCase()} (its quantity is 0).` });
    const idle = laborLine(area.id, 'labor', code, `Install ${p.label.toLowerCase()}`, hoursFor(designQty), crew, ov, 0);
    return { lines: [matLine, idle], description: '', cost: matLine.cost + idle.cost, finalR: null, fillsCavity: null, partial: false, none: true };
  }
  const partial = coversPart(covered, area.sqft);
  if (partial && fillsCavity) fillsCavity = false;
  const loose = mat.unit === 'bag' || mat.unit === 'board_ft';
  if (loose && thickness !== null) {
    // An estimator's quantity: never more than a full cavity (cut, with a warning), and the item
    // says what that quantity installs (L23, R3).
    if (room !== null && matLine.isOverridden) {
      const most = mat.unit === 'bag' ? Math.ceil(((area.sqft * room) / mat.coverageSqftIn!) * waste - 1e-9) : qty1(area.sqft * room * waste);
      if (matLine.qty > most) {
        warnings.push({
          code: 'override_capped',
          areaId: area.id,
          tier,
          message: `${area.name}: ${fmtNum(matLine.qty)} ${unitWord(mat.unit, matLine.qty)} of ${p.label.toLowerCase()} is more than ${cavity} holds. ${capitalize(tier)} is priced with ${fmtNum(most)}, a full cavity.`,
        });
        matLine = { ...matLine, qty: most, cost: money(most * mat.costPerUnit) };
      }
    }
    if (matLine.isOverridden && matLine.qty !== matLine.modelQty && waste > 0 && area.sqft > 0) {
      const installed = matLine.qty / waste;
      const t = mat.unit === 'bag' ? (installed * mat.coverageSqftIn!) / area.sqft : installed / area.sqft;
      thickness = room === null ? t : Math.min(t, room); // never more R than the cavity holds (L23b)
      achievedR = existingR + thickness * p.rPerInch!;
    }
    fillsCavity = room === null ? null : thickness >= room - THICKNESS_TOLERANCE_IN;
  }
  const matCost = matLine.cost;
  // Install labor is priced for the quantity priced: a changed quantity moves the hours with it
  // (the model's hours stay the model's). A changed number of hours still wins.
  const labor = laborLine(area.id, 'labor', code, `Install ${p.label.toLowerCase()}`, hoursFor(designQty), crew, ov, hoursFor(pricedUnits(matLine, designQty, waste)));

  // A fill that fills the cavity states what the cavity holds, rounded down to 0.1: never more R
  // than it holds (L23b; R-32.65 reads R-32.6, not R-32.7: review A F11).
  const cavityR = loose && fillsCavity === true && room !== null;
  const rLabel = `R-${fmtR(cavityR ? floorR(achievedR) : achievedR)}`;
  let description: string;
  if (mat.rValue && mat.thicknessIn) {
    const where = coverageText(covered, area.sqft);
    description =
      existingR > 0
        ? `${p.label} to ${rLabel} (R-${fmtR(mat.rValue)} batts, ${fmtIn(mat.thicknessIn)} in thick), ${where} sq ft`
        : `${p.label} to ${rLabel} (${fmtIn(mat.thicknessIn)} in thick), ${where} sq ft`;
  } else if (thickness !== null && fillsCavity && depth !== null) {
    description =
      existingIn > 0
        ? `${p.label} to ${rLabel} (~${fmtIn(thickness)} in added, fills the ${fmtIn(depth)} in cavity), ${fmtSqft(area.sqft)} sq ft`
        : `${p.label} to ${rLabel} (fills the ${fmtIn(depth)} in cavity), ${fmtSqft(area.sqft)} sq ft`;
  } else if (thickness !== null) {
    description = `${p.label} to ${rLabel} (~${fmtNum(round1(thickness))}" added), ${fmtSqft(area.sqft)} sq ft`;
  } else {
    description = `${p.label}, ${rLabel}, ${coverageText(covered, area.sqft)} sq ft`;
  }

  return { lines: [matLine, labor], description, cost: matCost + labor.cost, finalR: achievedR, fillsCavity, partial, none: false };
}

/**
 * The square feet a material sold by the square foot (batts, air sealing) covers: the quantity
 * priced over the waste, which the item states (review A F3). With `cap` (batts: one layer), an
 * estimator's quantity above the whole area is cut to the whole area (the model's quantity), with
 * an override_capped warning, as a fill is cut to a full cavity (L23). Air sealing is not cut: knee
 * walls and gaps can be more surface than the floor (L7), and the item states the sq ft priced.
 */
function sqftCoverage(
  area: AreaInput,
  line: PricedLine,
  waste: number,
  tier: Tier,
  what: string,
  warnings: PricingWarning[],
  cap: boolean,
): { line: PricedLine; covered: number } {
  if (!line.isOverridden || !(waste > 0) || line.modelQty === null) return { line, covered: area.sqft };
  if (cap && line.qty > line.modelQty) {
    warnings.push({
      code: 'override_capped',
      areaId: area.id,
      tier,
      message: `${area.name}: ${fmtSqft(line.qty)} sq ft of ${what} is more than the ${fmtSqft(area.sqft)} sq ft area. ${capitalize(tier)} is priced with ${fmtSqft(line.modelQty)} sq ft, the whole area.`,
    });
    line = { ...line, qty: line.modelQty, cost: money(line.modelQty * (line.unitCost ?? 0)) };
  }
  return { line, covered: line.qty === line.modelQty ? area.sqft : line.qty / waste };
}

/** Covering visibly less than the whole area (F3). */
const coversPart = (covered: number, sqft: number) => covered < sqft && fmtSqft(covered) !== fmtSqft(sqft);

/** "800"; "95 of 800" when only part of the area is covered; "1,500" when more surface than the area is (F3). */
function coverageText(covered: number, sqft: number): string {
  if (coversPart(covered, sqft)) return `${fmtSqft(covered)} of ${fmtSqft(sqft)}`;
  return fmtSqft(fmtSqft(covered) === fmtSqft(sqft) ? sqft : covered);
}

/** "the 3.5 in cavity", saying when a wall had no depth entered (a 2x4 wall, OD5). */
function cavityText(area: AreaInput, depth: number): string {
  const noDepth = area.depthIn === null && depth === DEFAULT_WALL_CAVITY_IN ? ' (no depth entered: a 2x4 wall)' : '';
  return `the ${fmtIn(depth)} in cavity${noDepth}`;
}

/** Where air sealing is done, in the words of each kind of job (S3-F20). */
const AIR_SEALING_WHERE: Record<JobType, string> = {
  attic: 'top plates, penetrations and bypasses',
  walls: 'gaps around outlets, windows, doors and penetrations',
  crawlspace: 'the rim, penetrations and gaps in the floor above',
  rim_joist: 'the rim joist, the sill plate and penetrations',
  garage: 'gaps and penetrations between the garage and the house',
  commercial: 'penetrations and gaps',
};

function priceAirSealing(
  area: AreaInput,
  s: PricingSnapshot,
  k: CoefficientSet,
  access: number,
  crew: CrewConfig,
  ov: Record<string, LineOverride>,
  tier: Tier,
  warnings: PricingWarning[],
): { lines: PricedLine[]; description: string; cost: number; partial: boolean; none: boolean } {
  const code: ProductCode = 'air_sealing';
  const designQty = area.sqft;
  const mat = material(s, code);
  const waste = findCoefficient(k, 'waste_factor', { product: code, jobType: area.jobType })?.value ?? 1;
  const qty = qty1(designQty * waste);
  const setup = findCoefficient(k, 'setup_hours', { product: code, jobType: area.jobType })?.value ?? 0;
  const perUnit = coeff(k, 'labor_hrs_per_unit', { product: code, jobType: area.jobType });
  const hoursFor = (units: number) => setup + units * perUnit * access; // in this order (F6)

  const lines: PricedLine[] = [];
  let matCost = 0;
  let units = designQty;
  let covered = area.sqft;
  let none = false;
  if (mat) {
    const c = sqftCoverage(area, materialLine(area.id, code, mat, mat.name, designQty, qty, ov), waste, tier, 'air sealing', warnings, false);
    const line = c.line;
    covered = c.covered;
    matCost = line.cost;
    units = pricedUnits(line, designQty, waste);
    lines.push(line);
    none = !(line.qty > 0);
  }
  // A quantity of 0: no air sealing here, and no hours for it unless typed (F4).
  const labor = laborLine(area.id, 'labor', code, 'Air sealing labor', hoursFor(designQty), crew, ov, none ? 0 : hoursFor(units));
  lines.push(labor);
  if (none) warnings.push({ code: 'product_zero', areaId: area.id, tier, message: `${area.name}: ${capitalize(tier)} installs no air sealing (its quantity is 0).` });
  return {
    lines,
    description: `Air sealing of ${AIR_SEALING_WHERE[area.jobType]} (${coverageText(covered, area.sqft)} sq ft)`,
    cost: matCost + labor.cost,
    partial: coversPart(covered, area.sqft),
    none,
  };
}

/**
 * The design units the install labor is priced for: the model's design quantity, or, when the
 * estimator changed the quantity, the quantity priced before waste (70 bags at 8% waste: 64.8
 * bags' worth of work).
 */
function pricedUnits(line: PricedLine, designQty: number, waste: number): number {
  return line.isOverridden && line.qty !== line.modelQty && waste > 0 ? line.qty / waste : designQty;
}

/**
 * The overrides as they apply to `tier`. An override is the estimator's number for the tier they
 * changed (override.tier); another tier with the same line gets its own value scaled by the same
 * proportion, so a change on Good never copies Good's quantity onto a deeper Best fill. Quantities
 * scale from each tier's model quantity (`pure`); hours from each tier's hours for the quantities
 * it prices (`base`), so the same bags take the same hours in every option. Without a usable base
 * (no tier, the source tier or line missing, a zero value) the number is used as-is.
 */
function overridesForTier(
  overrides: Record<string, LineOverride>,
  tier: Tier,
  pure: Map<Tier, PricedOption>,
  base: Map<Tier, PricedOption>,
): Record<string, LineOverride> {
  const out: Record<string, LineOverride> = {};
  const lineIn = (m: Map<Tier, PricedOption>, t: Tier, key: string) => m.get(t)?.lines.find((l) => l.key === key);
  for (const [key, o] of Object.entries(overrides)) {
    const scaled: LineOverride = { ...o };
    if (o.tier && o.tier !== tier) {
      const [fromQ, toQ] = [lineIn(pure, o.tier, key), lineIn(pure, tier, key)];
      if (isNum(o.qty) && fromQ && toQ && isNum(fromQ.modelQty) && fromQ.modelQty > 0 && isNum(toQ.modelQty)) {
        const q = toQ.modelQty * (o.qty / fromQ.modelQty);
        scaled.qty = toQ.unit === 'bag' ? Math.ceil(q - 1e-9) : round1(q);
      }
      const [fromH, toH] = [lineIn(base, o.tier, key), lineIn(base, tier, key)];
      if (isNum(o.hours) && fromH && toH && isNum(fromH.hours) && fromH.hours > 0 && isNum(toH.hours)) {
        scaled.hours = round2(toH.hours * (o.hours / fromH.hours));
      }
    }
    out[key] = scaled;
  }
  return out;
}

function materialLine(
  areaId: string,
  productCode: ProductCode,
  mat: MaterialConfig,
  description: string,
  designQty: number,
  modelQty: number,
  ov: Record<string, LineOverride>,
): PricedLine {
  const key = lineKey(areaId, productCode, 'material');
  const o = ov[key];
  const overrideQty = o && typeof o.qty === 'number' && Number.isFinite(o.qty) && o.qty >= 0 ? o.qty : null;
  const qty = overrideQty ?? modelQty;
  return {
    key,
    areaId,
    kind: 'material',
    product: productCode,
    materialId: mat.id,
    description,
    qty,
    unit: mat.unit,
    hours: null,
    unitCost: mat.costPerUnit,
    cost: money(qty * mat.costPerUnit),
    designQty: round2(designQty),
    modelQty,
    modelHours: null,
    modelCost: money(modelQty * mat.costPerUnit),
    isOverridden: overrideQty !== null,
    overrideReason: overrideQty !== null ? o!.reason : null,
  };
}

/**
 * A labor or removal line. `hours` is the model's; `pricedHours` is what the work as priced takes
 * (install labor for a changed quantity), defaulting to the model's. An estimator's hours win.
 */
function laborLine(
  areaId: string,
  kind: LineKind,
  productCode: ProductCode,
  description: string,
  hours: number,
  crew: CrewConfig,
  ov: Record<string, LineOverride>,
  pricedHours: number = hours,
): PricedLine {
  const key = lineKey(areaId, productCode, kind);
  const o = ov[key];
  const modelHours = round2(hours);
  const overrideHours = o && typeof o.hours === 'number' && Number.isFinite(o.hours) && o.hours >= 0 ? round2(o.hours) : null;
  const h = overrideHours ?? round2(pricedHours);
  return {
    key,
    areaId,
    kind,
    product: productCode,
    materialId: null,
    description,
    qty: h,
    unit: 'hour',
    hours: h,
    unitCost: crew.blendedHourlyCost,
    cost: money(h * crew.blendedHourlyCost),
    designQty: null,
    modelQty: null,
    modelHours,
    modelCost: money(modelHours * crew.blendedHourlyCost),
    isOverridden: overrideHours !== null,
    overrideReason: overrideHours !== null ? o!.reason : null,
  };
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const round1 = (n: number) => Math.round(n * 10) / 10;
/** A model quantity to 0.1, never 0 for a positive need (a 0.04 sq ft area still gets its 0.1: F12). */
const qty1 = (n: number) => (n > 0 ? Math.max(0.1, round1(n)) : round1(n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const dedupe = (xs: string[]) => [...new Set(xs)];
const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
/**
 * Square feet: whole numbers, with one decimal under 10 sq ft and two significant digits under 1 sq
 * ft, so a tiny area never reads "0" (S3-F23, L17; 0.04 sq ft: review A F12).
 */
const fmtSqft = (n: number) =>
  n > 0 && n < 1 ? n.toLocaleString('en-US', { maximumSignificantDigits: 2 }) : n.toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 1 : 0 });
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtR = (n: number) => round1(n).toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false });
/** An R-value rounded down to 0.1: what a full cavity holds, never more (L23b, F11). */
const floorR = (n: number) => Math.floor(n * 10 + 1e-6) / 10;
/** Inches: up to two decimals, as a framing depth is written (3.5, 5.5, 7.25). */
const fmtIn = (n: number) => (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2, useGrouping: false });
const unitWord = (unit: string, qty: number) => (unit === 'bag' ? (qty === 1 ? 'bag' : 'bags') : unit === 'board_ft' ? 'board ft' : unit);
/** "$5,420", or "$0.40" for an amount with cents. */
const usd = (n: number) =>
  `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
