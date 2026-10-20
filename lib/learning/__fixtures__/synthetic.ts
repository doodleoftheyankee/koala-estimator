// Synthetic completed jobs with KNOWN true coefficients, for calibration tests. Placeholder
// numbers mirroring the seed migration, not real pricing.
import type { AccessLevel, CoeffKind, JobType, ProductCode } from '@/lib/pricing';
import type { DriveObservation, Observation, StoredCoefficient } from '../types';
import { createRng } from './prng';

const DAY_MS = 86_400_000;

type Scope = Partial<Pick<StoredCoefficient, 'product' | 'jobType' | 'accessLevel'>>;

const stored = (kind: CoeffKind, value: number, lo: number, hi: number, scope: Scope = {}): StoredCoefficient => ({
  kind,
  product: scope.product ?? null,
  jobType: scope.jobType ?? null,
  accessLevel: scope.accessLevel ?? null,
  value,
  priorValue: value,
  lowerBound: lo,
  upperBound: hi,
  sampleSize: 0,
  nEff: 0,
  confidence: 0,
});

/** The seeded active set with its guardrail bounds (supabase/migrations/20261020000001_init.sql). */
export function seedActive(): StoredCoefficient[] {
  return [
    stored('waste_factor', 1.1, 1.0, 1.6, { product: 'ocsf' }),
    stored('waste_factor', 1.1, 1.0, 1.6, { product: 'ccsf' }),
    stored('waste_factor', 1.08, 1.0, 1.6, { product: 'cellulose' }),
    stored('waste_factor', 1.08, 1.0, 1.6, { product: 'fiberglass_blown' }),
    stored('waste_factor', 1.05, 1.0, 1.4, { product: 'batts' }),
    stored('labor_hrs_per_unit', 0.004, 0.0005, 0.05, { product: 'ocsf' }),
    stored('labor_hrs_per_unit', 0.006, 0.0005, 0.05, { product: 'ccsf' }),
    stored('labor_hrs_per_unit', 0.15, 0.02, 1.0, { product: 'cellulose' }),
    stored('labor_hrs_per_unit', 0.15, 0.02, 1.0, { product: 'fiberglass_blown' }),
    stored('labor_hrs_per_unit', 0.015, 0.002, 0.1, { product: 'batts' }),
    stored('labor_hrs_per_unit', 0.006, 0.001, 0.05, { product: 'air_sealing' }),
    stored('setup_hours', 3, 0.5, 12, { product: 'ocsf' }),
    stored('setup_hours', 3, 0.5, 12, { product: 'ccsf' }),
    stored('setup_hours', 2, 0.5, 8, { product: 'cellulose' }),
    stored('setup_hours', 2, 0.5, 8, { product: 'fiberglass_blown' }),
    stored('setup_hours', 1, 0.25, 6, { product: 'batts' }),
    stored('setup_hours', 0.5, 0.1, 4, { product: 'air_sealing' }),
    stored('setup_hours', 1, 0.25, 6, { product: 'removal' }),
    stored('access_mult', 1.0, 0.8, 1.3, { accessLevel: 'easy' }),
    stored('access_mult', 1.15, 0.9, 1.6, { accessLevel: 'moderate' }),
    stored('access_mult', 1.35, 1.0, 2.0, { accessLevel: 'difficult' }),
    stored('access_mult', 1.6, 1.1, 2.5, { accessLevel: 'extreme' }),
    stored('removal_hrs_per_sqft', 0.02, 0.005, 0.1, { jobType: 'attic' }),
    stored('removal_hrs_per_sqft', 0.03, 0.005, 0.12, { jobType: 'crawlspace' }),
    stored('removal_hrs_per_sqft', 0.025, 0.005, 0.12),
    stored('drive_time_factor', 1.1, 0.8, 1.8),
  ];
}

/** The process that generates actuals. `${product}|${jobType}` keys override per job type. */
export interface TrueModel {
  waste: Partial<Record<ProductCode, number>>;
  wasteByJobType: Record<string, number>;
  rate: Partial<Record<ProductCode, number>>;
  rateByJobType: Record<string, number>;
  setup: Partial<Record<ProductCode, number>>;
  access: Record<AccessLevel, number>;
  removalRate: number;
  removalRateByJobType: Partial<Record<JobType, number>>;
  removalSetup: number;
  driveFactor: number;
}

/** The truth that equals the seeded active set (so the active set is already right). */
export const SEED_TRUTH: TrueModel = {
  waste: { ocsf: 1.1, ccsf: 1.1, cellulose: 1.08, fiberglass_blown: 1.08, batts: 1.05 },
  wasteByJobType: {},
  rate: { ocsf: 0.004, ccsf: 0.006, cellulose: 0.15, fiberglass_blown: 0.15, batts: 0.015, air_sealing: 0.006 },
  rateByJobType: {},
  setup: { ocsf: 3, ccsf: 3, cellulose: 2, fiberglass_blown: 2, batts: 1, air_sealing: 0.5 },
  access: { easy: 1, moderate: 1.15, difficult: 1.35, extreme: 1.6 },
  removalRate: 0.025,
  removalRateByJobType: { attic: 0.02, crawlspace: 0.03 },
  removalSetup: 1,
  driveFactor: 1.1,
};

export const trueWaste = (t: TrueModel, p: ProductCode, jt: JobType): number =>
  t.wasteByJobType[`${p}|${jt}`] ?? t.waste[p] ?? 1;
export const trueRate = (t: TrueModel, p: ProductCode, jt: JobType): number =>
  t.rateByJobType[`${p}|${jt}`] ?? t.rate[p] ?? 0;
export const trueRemovalRate = (t: TrueModel, jt: JobType): number => t.removalRateByJobType[jt] ?? t.removalRate;

export interface GenerateOptions {
  seed: number;
  jobs: number;
  now: Date;
  truth: TrueModel;
  noise?: number; // relative sd of the multiplicative noise (default 0.05)
  products?: readonly ProductCode[];
  jobTypes?: readonly JobType[];
  accessLevels?: readonly AccessLevel[];
  minDaysAgo?: number; // default 0
  maxDaysAgo?: number; // default 365
  removalShare?: number; // share of areas that also have a removal row (default 0.3)
  maxAreasPerJob?: number; // default 2
  hoursFactor?: number; // corrupts actual hours (3 = keyed in triple)
  qtyFactor?: number;
  idPrefix?: string;
}

const COVERAGE: Partial<Record<ProductCode, number>> = { cellulose: 200, fiberglass_blown: 450 };

/** Design units for an area, the way the engine derives them (board ft, bags or sq ft). */
function designUnits(product: ProductCode, sqft: number, inches: number): number {
  if (product === 'ocsf' || product === 'ccsf') return sqft * (inches / 3);
  const coverage = COVERAGE[product];
  return coverage ? (sqft * inches) / coverage : sqft;
}

export function generateJobs(opts: GenerateOptions): { observations: Observation[]; drive: DriveObservation[] } {
  const rng = createRng(opts.seed);
  const t = opts.truth;
  const noise = opts.noise ?? 0.05;
  const products = opts.products ?? ['cellulose', 'ocsf', 'batts'];
  const jobTypes = opts.jobTypes ?? ['attic', 'walls', 'crawlspace'];
  const levels = opts.accessLevels ?? ['easy', 'moderate', 'difficult', 'extreme'];
  const minDays = opts.minDaysAgo ?? 0;
  const maxDays = opts.maxDaysAgo ?? 365;
  const prefix = opts.idPrefix ?? 'j';
  const hoursFactor = opts.hoursFactor ?? 1;
  const qtyFactor = opts.qtyFactor ?? 1;
  const mult = () => 1 + noise * Math.min(3, Math.max(-3, rng.normal()));

  const observations: Observation[] = [];
  const drive: DriveObservation[] = [];
  for (let j = 0; j < opts.jobs; j++) {
    const jobId = `${prefix}-${String(j).padStart(5, '0')}`;
    const completedAt = new Date(opts.now.getTime() - rng.uniform(minDays, maxDays) * DAY_MS).toISOString();
    const areas = rng.int(1, opts.maxAreasPerJob ?? 2);
    for (let a = 0; a < areas; a++) {
      const areaId = `${jobId}-a${a}`;
      const product = rng.pick(products);
      const jobType = rng.pick(jobTypes);
      const accessLevel = rng.pick(levels);
      const sqft = Math.round(rng.uniform(200, 2500));
      const designQty = Math.round(designUnits(product, sqft, rng.uniform(6, 16)) * 100) / 100;
      const hours = (t.setup[product] ?? 0) + designQty * trueRate(t, product, jobType) * t.access[accessLevel];
      observations.push({
        jobId,
        areaId,
        completedAt,
        product,
        jobType,
        accessLevel,
        sqft,
        designQty,
        modelQty: null,
        estQty: null,
        modelHours: null,
        estHours: null,
        actualQty: designQty * trueWaste(t, product, jobType) * mult() * qtyFactor,
        actualHours: hours * mult() * hoursFactor,
      });
      if (rng.chance(opts.removalShare ?? 0.3)) {
        const removal = t.removalSetup + sqft * trueRemovalRate(t, jobType) * t.access[accessLevel];
        observations.push({
          jobId,
          areaId,
          completedAt,
          product: 'removal',
          jobType,
          accessLevel,
          sqft,
          designQty: null,
          modelQty: null,
          estQty: null,
          modelHours: null,
          estHours: null,
          actualQty: null,
          actualHours: removal * mult() * hoursFactor,
        });
      }
    }
    const estMinutes = Math.round(rng.uniform(10, 60));
    drive.push({ jobId, completedAt, estMinutes, actualMinutes: estMinutes * t.driveFactor * mult() });
  }
  return { observations, drive };
}
