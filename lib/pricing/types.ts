// Domain types shared by the pricing engine, the offline client and the server.
// Everything numeric that drives a price comes from PricingSnapshot or CoefficientSet,
// both loaded from the database. Nothing here is a business number.

export const JOB_TYPES = ['attic', 'walls', 'crawlspace', 'rim_joist', 'garage', 'commercial'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const PRODUCTS = ['ocsf', 'ccsf', 'cellulose', 'fiberglass_blown', 'batts', 'air_sealing', 'removal'] as const;
export type ProductCode = (typeof PRODUCTS)[number];

export const ACCESS_LEVELS = ['easy', 'moderate', 'difficult', 'extreme'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const TIERS = ['good', 'better', 'best'] as const;
export type Tier = (typeof TIERS)[number];

export type ProductUnit = 'board_ft' | 'bag' | 'sqft' | 'linear_ft' | 'hour' | 'each';
export type LineKind = 'material' | 'labor' | 'removal' | 'disposal' | 'drive' | 'misc' | 'discount';

export const COEFF_KINDS = [
  'waste_factor',
  'labor_hrs_per_unit',
  'access_mult',
  'setup_hours',
  'removal_hrs_per_sqft',
  'drive_time_factor',
  'photo_area_bias',
] as const;
export type CoeffKind = (typeof COEFF_KINDS)[number];

// ---------------------------------------------------------------------------
// Configuration (from DB)
// ---------------------------------------------------------------------------

export interface PricingSettings {
  overheadPct: number; // overhead as fraction of direct cost
  targetMarginPct: number; // gross margin on price
  floorMarginPct: number;
  ceilingMarginPct: number;
  minimumJobPrice: number;
  priceRounding: number; // round customer price UP to this many dollars
  productiveHoursPerDay: number; // per crew member
  vehicleCostPerTrip: number; // per crew-day
  disposalCostPerSqft: number;
  estimatorOverrideLimitPct: number;
  estimatorsSeeCosts: boolean;
  deviationThreshold: number;
  quoteValidDays: number;
  financing: { provider: string | null; apr: number; termMonths: number; show: boolean };
}

export interface ProductConfig {
  code: ProductCode;
  label: string;
  unit: ProductUnit;
  rPerInch: number | null;
  isRBearing: boolean;
}

export interface MaterialConfig {
  id: string;
  productCode: ProductCode;
  name: string;
  unit: ProductUnit;
  costPerUnit: number;
  /** sqft x inches covered by one unit (bags). Null for per-sqft / per-board-ft products. */
  coverageSqftIn: number | null;
}

export interface CrewConfig {
  id: string;
  name: string;
  size: number;
  blendedHourlyCost: number; // per person-hour, fully burdened
}

export interface CodeRequirement {
  jobType: JobType;
  minR: number;
  edition: string;
}

export interface TierTemplate {
  jobType: JobType;
  tier: Tier;
  label: string;
  primaryProduct: ProductCode;
  targetR: number | null; // null = code minimum
  includeAirSealing: boolean;
  includeRemoval: boolean;
  bullets: string[];
}

export interface PricingSnapshot {
  settings: PricingSettings;
  products: ProductConfig[];
  materials: MaterialConfig[]; // default material per product
  crews: CrewConfig[];
  defaultCrewId: string | null;
  codeRequirements: CodeRequirement[];
  tierTemplates: TierTemplate[];
}

export interface Coefficient {
  kind: CoeffKind;
  product: ProductCode | null;
  jobType: JobType | null;
  accessLevel: AccessLevel | null;
  value: number;
}

export interface CoefficientSet {
  id: string;
  version: number;
  coefficients: Coefficient[];
}

/** What the client caches for offline pricing. `hash` identifies snapshot + coefficient set. */
export interface PricingBundle {
  hash: string;
  builtAt: string;
  snapshot: PricingSnapshot;
  coefficientSet: CoefficientSet;
}

// ---------------------------------------------------------------------------
// Estimate input
// ---------------------------------------------------------------------------

export interface AreaInput {
  id: string;
  name: string;
  jobType: JobType;
  sqft: number;
  currentR: number;
  targetR: number | null; // null = template / code default
  existingMaterial: string | null;
  existingDepthIn: number | null;
  /** Cavity depth (walls, rim joist, framed floors). Caps installed thickness when set. */
  depthIn: number | null;
  accessLevel: AccessLevel;
  removalNeeded: boolean;
  prepNotes: string | null;
}

export interface PriceOverride {
  price: number;
  reason: string;
}

export interface EstimateInput {
  areas: AreaInput[];
  crewId: string | null;
  driveMinutesOneWay: number | null;
  overrides: Partial<Record<Tier, PriceOverride>>;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface PricedLine {
  areaId: string | null;
  kind: LineKind;
  product: ProductCode | null;
  materialId: string | null;
  description: string;
  qty: number;
  unit: ProductUnit | null;
  hours: number | null;
  unitCost: number | null;
  cost: number;
  /** Quantity before waste factor (the physics), and the model's quantity/hours/cost. */
  designQty: number | null;
  modelQty: number | null;
  modelHours: number | null;
  modelCost: number;
}

/** What the customer sees: one row per area scope item, sell price allocated by cost share. */
export interface CustomerItem {
  areaId: string | null;
  areaName: string;
  description: string;
  price: number;
}

export interface Financing {
  provider: string | null;
  apr: number;
  termMonths: number;
  monthly: number;
}

export interface PricedOption {
  tier: Tier;
  label: string;
  bullets: string[];
  lines: PricedLine[];
  customerItems: CustomerItem[];
  materialCost: number;
  laborHours: number;
  laborCost: number;
  driveCost: number;
  disposalCost: number;
  directCost: number;
  loadedCost: number;
  modelPrice: number;
  price: number;
  isOverridden: boolean;
  overrideReason: string | null;
  marginPct: number;
  belowFloor: boolean;
  crewDays: number;
  financing: Financing | null;
}

export interface PricingWarning {
  code:
    | 'already_at_target'
    | 'thickness_capped'
    | 'no_template'
    | 'tier_skipped'
    | 'override_below_floor'
    | 'no_crew'
    | 'tier_price_order';
  areaId: string | null;
  tier: Tier | null;
  message: string;
}

export interface PricedEstimate {
  options: PricedOption[];
  warnings: PricingWarning[];
  crewId: string;
}

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingConfigError';
  }
}
