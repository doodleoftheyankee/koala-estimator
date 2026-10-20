import { coeff, findCoefficient } from './coefficients';
import { allocate, ceilHalf, money, monthlyPayment, roundUpTo } from './finance';
import type {
  AreaInput,
  LineOverride,
  CoefficientSet,
  CrewConfig,
  CustomerItem,
  EstimateInput,
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

/**
 * Prices an estimate. Pure and deterministic: same input + snapshot + coefficients => same output.
 *
 * Throws PricingConfigError when the configuration is unusable (missing crew, product,
 * coefficient, nonsensical margin). Throws RangeError for invalid input. Never returns NaN.
 */
export function priceEstimate(
  input: EstimateInput,
  snapshot: PricingSnapshot,
  coeffs: CoefficientSet,
): PricedEstimate {
  validateSnapshot(snapshot);
  input.areas.forEach(validateArea);

  const warnings: PricingWarning[] = [];
  const crew = pickCrew(snapshot, input.crewId);
  const options: PricedOption[] = [];

  const overrides = input.lineOverrides ?? {};
  const hasLineOverrides = Object.keys(overrides).length > 0;
  for (const tier of TIERS) {
    const option = priceTier(tier, input, snapshot, coeffs, crew, warnings, overrides);
    if (!option) continue;
    if (hasLineOverrides) {
      // The pure-model price is what the learning loop and approval limits compare against.
      const pure = priceTier(tier, input, snapshot, coeffs, crew, [], {});
      option.modelPrice = pure?.adjustedPrice ?? option.adjustedPrice;
    }
    options.push(option);
  }
  // Good should cost less than better, better less than best. If the configured products and
  // costs say otherwise, the estimator needs to know before a customer sees it.
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

function material(s: PricingSnapshot, code: ProductCode): MaterialConfig | null {
  return s.materials.find((m) => m.productCode === code) ?? null;
}

function requireMaterial(s: PricingSnapshot, code: ProductCode): MaterialConfig {
  const m = material(s, code);
  if (!m) throw new PricingConfigError(`no default material for ${code}`);
  return m;
}

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
  let removalSqft = 0;

  input.areas.forEach((area, i) => {
    const tpl = templates[i]!;
    const access = coeff(k, 'access_mult', { accessLevel: area.accessLevel });
    const hasExisting = area.currentR > 0 || !!area.existingMaterial;
    const removal = area.removalNeeded || (tpl.includeRemoval && hasExisting);

    if (removal) {
      const hours =
        (findCoefficient(k, 'setup_hours', { product: 'removal' })?.value ?? 0) +
        area.sqft * coeff(k, 'removal_hrs_per_sqft', { jobType: area.jobType }) * access;
      const line = laborLine(area.id, 'removal', 'removal', `Remove existing insulation, ${fmtInt(area.sqft)} sq ft`, hours, crew, ov);
      lines.push(line);
      removalSqft += area.sqft;
      groups.push({
        areaId: area.id,
        areaName: area.name,
        scope: 'removal',
        description: `Remove and dispose of existing insulation (${fmtInt(area.sqft)} sq ft)`,
        cost: line.cost + area.sqft * s.settings.disposalCostPerSqft,
      });
    }

    const primary = priceProductScope(area, tpl, removal, s, k, access, crew, tier, warnings, ov);
    if (primary) {
      lines.push(...primary.lines);
      groups.push({ areaId: area.id, areaName: area.name, scope: 'primary', description: primary.description, cost: primary.cost });
    }

    if (tpl.includeAirSealing && tpl.primaryProduct !== 'air_sealing') {
      const air = priceAirSealing(area, s, k, access, crew, ov);
      lines.push(...air.lines);
      groups.push({ areaId: area.id, areaName: area.name, scope: 'air_sealing', description: air.description, cost: air.cost });
    }
  });

  if (groups.length === 0) {
    warnings.push({
      code: 'tier_skipped',
      areaId: null,
      tier,
      message: `The ${tier} option has no work to do (every area is already at its target R-value).`,
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
      description: `Disposal, ${fmtInt(removalSqft)} sq ft`,
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
  const adjustedPrice = roundUpTo(Math.max(loadedCost / (1 - st.targetMarginPct), st.minimumJobPrice), st.priceRounding);

  const override = input.overrides[tier];
  const isOverridden = !!override && Number.isFinite(override.price) && override.price > 0;
  const price = isOverridden ? money(override!.price) : adjustedPrice;
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

  const allocations = allocate(price, groups.map((g) => g.cost));
  const customerItems: CustomerItem[] = groups.map((g, i) => ({
    areaId: g.areaId,
    areaName: g.areaName,
    description: g.description,
    price: allocations[i] ?? 0,
  }));

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

  const tpl0 = templates[0]!;
  return {
    tier,
    label: input.areas.length === 1 ? tpl0.label : `${capitalize(tier)} package`,
    bullets: dedupe(templates.flatMap((t) => t.bullets)),
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
): { lines: PricedLine[]; description: string; cost: number } | null {
  const code = tpl.primaryProduct;
  const p = product(s, code);
  if (code === 'air_sealing') return priceAirSealing(area, s, k, access, crew, ov);
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

  const mat = requireMaterial(s, code);
  let designQty: number;
  let achievedR = targetR;
  let thickness: number | null = null;

  if (mat.unit === 'board_ft' || mat.unit === 'bag') {
    if (!p.rPerInch || p.rPerInch <= 0) throw new PricingConfigError(`${code} has no R per inch`);
    thickness = addedR / p.rPerInch;
    if (area.depthIn !== null && thickness > area.depthIn) {
      thickness = area.depthIn;
      achievedR = existingR + thickness * p.rPerInch;
      warnings.push({
        code: 'thickness_capped',
        areaId: area.id,
        tier,
        message: `${area.name}: a ${fmtNum(area.depthIn)}" cavity only fits R-${fmtNum(round1(achievedR))} of ${p.label.toLowerCase()} (target R-${fmtNum(targetR)}).`,
      });
    }
    designQty = mat.unit === 'board_ft' ? area.sqft * thickness : (area.sqft * thickness) / mat.coverageSqftIn!;
  } else {
    designQty = area.sqft;
  }

  const waste = coeff(k, 'waste_factor', { product: code, jobType: area.jobType });
  const rawQty = designQty * waste;
  const modelQty = mat.unit === 'bag' ? Math.ceil(rawQty - 1e-9) : round1(rawQty);

  const hours =
    (findCoefficient(k, 'setup_hours', { product: code, jobType: area.jobType })?.value ?? 0) +
    designQty * coeff(k, 'labor_hrs_per_unit', { product: code, jobType: area.jobType }) * access;

  const matLine = materialLine(area.id, code, mat, `${mat.name}`, designQty, modelQty, ov);
  const matCost = matLine.cost;
  const labor = laborLine(area.id, 'labor', code, `Install ${p.label.toLowerCase()}`, hours, crew, ov);

  const rLabel = `R-${fmtNum(round1(achievedR))}`;
  const description =
    thickness !== null
      ? `${p.label} to ${rLabel} (~${fmtNum(round1(thickness))}" added), ${fmtInt(area.sqft)} sq ft`
      : `${p.label}, ${rLabel}, ${fmtInt(area.sqft)} sq ft`;

  return { lines: [matLine, labor], description, cost: matCost + labor.cost };
}

function priceAirSealing(
  area: AreaInput,
  s: PricingSnapshot,
  k: CoefficientSet,
  access: number,
  crew: CrewConfig,
  ov: Record<string, LineOverride>,
): { lines: PricedLine[]; description: string; cost: number } {
  const code: ProductCode = 'air_sealing';
  const designQty = area.sqft;
  const mat = material(s, code);
  const waste = findCoefficient(k, 'waste_factor', { product: code, jobType: area.jobType })?.value ?? 1;
  const qty = round1(designQty * waste);
  const hours =
    (findCoefficient(k, 'setup_hours', { product: code, jobType: area.jobType })?.value ?? 0) +
    designQty * coeff(k, 'labor_hrs_per_unit', { product: code, jobType: area.jobType }) * access;

  const lines: PricedLine[] = [];
  let matCost = 0;
  if (mat) {
    const line = materialLine(area.id, code, mat, mat.name, designQty, qty, ov);
    matCost = line.cost;
    lines.push(line);
  }
  const labor = laborLine(area.id, 'labor', code, 'Air sealing labor', hours, crew, ov);
  lines.push(labor);
  return {
    lines,
    description: `Air sealing of top plates, penetrations and bypasses (${fmtInt(area.sqft)} sq ft)`,
    cost: matCost + labor.cost,
  };
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

function laborLine(
  areaId: string,
  kind: LineKind,
  productCode: ProductCode,
  description: string,
  hours: number,
  crew: CrewConfig,
  ov: Record<string, LineOverride>,
): PricedLine {
  const key = lineKey(areaId, productCode, kind);
  const o = ov[key];
  const modelHours = round2(hours);
  const overrideHours = o && typeof o.hours === 'number' && Number.isFinite(o.hours) && o.hours >= 0 ? round2(o.hours) : null;
  const h = overrideHours ?? modelHours;
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
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const dedupe = (xs: string[]) => [...new Set(xs)];
const capitalize = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
