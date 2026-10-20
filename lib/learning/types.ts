// Contracts for the self-improving loop (PLAN.md §6). Everything in lib/learning except
// io.ts and nightly.ts is pure: plain data in, plain data out, no clock, no database.
// Callers pass `now` explicitly so runs are reproducible and testable.
import type {
  AccessLevel,
  CoeffKind,
  JobType,
  PricedOption,
  ProductCode,
  Tier,
} from '@/lib/pricing';

// ---------------------------------------------------------------------------
// Settings (app_settings.learning)
// ---------------------------------------------------------------------------

export interface LearningSettings {
  halfLifeDays: number; // recency weighting: w = 0.5^(age/halfLife)
  shrinkageK: number; // pseudo-observations pulling a cell toward its parent
  minNEff: number; // a cell needs this effective sample size to move at all
  maxStepPct: number; // max relative change per coefficient per run (0.10 = ±10%)
  holdoutFrac: number; // most recent fraction of observations used for the backtest
  winsorPct: number; // clip ratios at this percentile on each side
  autoPromote: boolean; // promote a candidate automatically when every gate passes
  minQuotesForWinModel: number; // cold-start threshold for the win model
  winHalfLifeDays: number;
  winL2: number; // L2 penalty for the logistic regression
}

// ---------------------------------------------------------------------------
// Calibration (coefficients from job actuals)
// ---------------------------------------------------------------------------

/**
 * One area x product scope of a completed, verified job: what the model predicted, what the
 * estimator quoted, and what actually happened. Built by observations.ts from the frozen
 * quote snapshot plus job_actuals.
 */
export interface Observation {
  jobId: string;
  areaId: string;
  completedAt: string; // ISO
  product: ProductCode; // 'removal' rows carry removal hours; 'air_sealing' rows are sealing
  jobType: JobType;
  accessLevel: AccessLevel;
  sqft: number;
  /** Units before waste (bags, board-ft, sq ft). Null for removal. */
  designQty: number | null;
  modelQty: number | null;
  estQty: number | null; // estimator's quantity (override or model)
  modelHours: number | null;
  estHours: number | null;
  actualQty: number | null;
  actualHours: number | null;
}

export interface DriveObservation {
  jobId: string;
  completedAt: string;
  estMinutes: number; // one-way estimate used at quote time
  actualMinutes: number; // one-way average reported by the crew
}

/** A coefficient as stored (active set), with its guardrail bounds. */
export interface StoredCoefficient {
  kind: CoeffKind;
  product: ProductCode | null;
  jobType: JobType | null;
  accessLevel: AccessLevel | null;
  value: number;
  priorValue: number;
  lowerBound: number;
  upperBound: number;
  sampleSize: number;
  nEff: number;
  confidence: number;
}

export interface CandidateCoefficient extends StoredCoefficient {
  stdError: number | null;
  wasClamped: boolean; // value hit lowerBound/upperBound
  wasStepLimited: boolean; // value hit the ±maxStepPct limit
  changed: boolean; // differs from the active value (or is a new cell)
  /** Human-readable explanation for the changelog: "n_eff 14.2, raw 1.17, shrunk 1.13, step-limited to 1.12". */
  note: string;
}

export interface GateResult {
  name: 'bounds' | 'step_limit' | 'min_evidence' | 'backtest' | 'sanity';
  passed: boolean;
  detail: string;
}

export interface BacktestMetrics {
  n: number; // holdout observations
  hoursMapeActive: number | null;
  hoursMapeCandidate: number | null;
  qtyMapeActive: number | null;
  qtyMapeCandidate: number | null;
}

export interface CalibrationInput {
  observations: Observation[];
  drive: DriveObservation[];
  active: StoredCoefficient[];
  settings: LearningSettings;
  now: Date;
}

export interface CalibrationResult {
  /** The full candidate set: every active coefficient (changed or copied) plus any new cells. */
  coefficients: CandidateCoefficient[];
  changedCount: number;
  gates: GateResult[];
  /** All gates passed. */
  passed: boolean;
  /** passed AND the backtest had enough holdout data to be meaningful. */
  autoPromotable: boolean;
  metrics: {
    nObservations: number;
    nUsed: number; // after exclusions/winsorizing
    holdout: BacktestMetrics | null;
  };
}

// ---------------------------------------------------------------------------
// Win model (price -> probability of winning)
// ---------------------------------------------------------------------------

export interface WinObservation {
  estimateId: string;
  won: boolean;
  decidedAt: string; // ISO
  /** price / loaded cost of the option the estimator recommended. */
  markup: number;
  price: number;
  jobType: string;
  source: string | null;
  sqft: number;
}

export interface WinFeatures {
  markup: number;
  jobType: string;
  source: string | null;
  sqft: number;
}

export interface PricePoint {
  price: number;
  marginPct: number;
  winProbability: number;
  expectedProfit: number; // P(win) x (price - loaded cost)
}

export interface PriceRecommendation extends PricePoint {
  curve: PricePoint[];
}

export interface WinRateBucket {
  label: string;
  quotes: number;
  wins: number;
  winRate: number;
}

// ---------------------------------------------------------------------------
// Deviation flags (estimator vs model, PLAN.md §6.5)
// ---------------------------------------------------------------------------

export interface DeviationReason {
  code:
    | 'labor_rate'
    | 'access'
    | 'setup'
    | 'waste'
    | 'design_qty'
    | 'price_override'
    | 'line_overrides'
    | 'low_confidence';
  text: string;
}

export interface DeviationFlag {
  /** Stable across syncs: `${lineKey}|${metric}` for lines, `${tier}|total_price` for totals. */
  key: string;
  tier: Tier;
  lineKey: string | null;
  metric: 'qty' | 'hours' | 'total_price';
  estimatorValue: number;
  modelValue: number;
  pctDiff: number; // signed: (estimator - model) / model
  reasons: DeviationReason[];
  /** One sentence for the UI, e.g. "Labor hours 38% above model for Main attic (cellulose)." */
  message: string;
}

export type DeviationOutcome = 'estimator_closer' | 'model_closer' | 'tie';

// ---------------------------------------------------------------------------
// Quote snapshot as stored in quotes.snapshot (written by app/api/quotes)
// ---------------------------------------------------------------------------

export interface QuoteSnapshotForLearning {
  options: PricedOption[];
  /** Added in Phase 2: the exact inputs priced at send time. Missing on Phase 1 quotes. */
  input?: {
    areas: Array<{ id: string; name: string; jobType: JobType; accessLevel: AccessLevel; sqft: number }>;
    driveMinutesOneWay: number | null;
  };
  flags?: DeviationFlag[];
}
