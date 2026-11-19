// Blower door arithmetic. Pure, and every function returns a finite number or null.
//
//   CFM50 = CFM × (50 ÷ Pa)^n                 the gauge's @ Pressure result at 50 Pa
//   reduction % = (pre50 − post50) ÷ pre50 × 100
//   a tier is reached when post50 ≤ pre50 × (1 − tier % ÷ 100)
//   BAS (CFM50) = max(0.35 × volume ÷ 60, 15 × occupants) × N-factor × height correction
//                                             BPI Building Analyst (ASHRAE 62-89)
//   ACH50 = CFM50 × 60 ÷ volume
import type { RebateProgram, RebateTier } from './settings';

/** Test pressure the program's numbers are quoted at. */
export const TARGET_PA = 50;

/** CFM at 50 Pa from a reading at another pressure. Null when the reading cannot be used. */
export function toCfm50(cfm: number, pa: number, exponent: number): number | null {
  if (!(cfm > 0) || !(pa > 0) || !(exponent > 0)) return null;
  const v = cfm * Math.pow(TARGET_PA / pa, exponent);
  return Number.isFinite(v) ? v : null;
}

/** Reduction from pre to post as a percent of pre (negative when post is higher). */
export function reductionPct(pre: number, post: number): number | null {
  if (!(pre > 0) || !(post >= 0)) return null;
  const v = ((pre - post) / pre) * 100;
  return Number.isFinite(v) ? v : null;
}

/** ACH50: air changes per hour at 50 Pa. Null without a house volume. */
export function ach50(cfm50: number, volume: number | null): number | null {
  if (!(cfm50 > 0) || volume === null || !(volume > 0)) return null;
  return (cfm50 * 60) / volume;
}

// ---------------------------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------------------------

/**
 * Readings are decimals worked out from a power, so "exactly on the limit" allows a sliver of
 * floating-point noise: a post50 a billionth of a CFM over the limit has reached the tier.
 */
const ON_LIMIT = 1e-9;

export interface TierRow {
  tier: RebateTier;
  /** The test-out at or below this CFM50 reaches the tier. */
  limit: number;
  reached: boolean;
}

export interface TierEvaluation {
  rows: TierRow[];
  /** The highest tier reached, or null. */
  hit: RebateTier | null;
  /** The lowest tier not reached, with what it takes. */
  next: { tier: RebateTier; limit: number; /** CFM50 still to take out, rounded up. */ need: number } | null;
  /** With the top tier reached: CFM50 below its limit, rounded down. */
  spare: number | null;
}

/** The program's tiers against a test-in and (once there is one) a test-out. */
export function evaluateTiers(pre50: number, post50: number | null, tiers: readonly RebateTier[]): TierEvaluation {
  const sorted = [...tiers].sort((a, b) => a.reductionPct - b.reductionPct);
  const rows = sorted.map((tier) => {
    const limit = pre50 * (1 - tier.reductionPct / 100);
    const reached = post50 !== null && post50 <= limit + Math.max(ON_LIMIT, limit * ON_LIMIT);
    return { tier, limit, reached };
  });
  const reachedRows = rows.filter((r) => r.reached);
  const hit = reachedRows.length ? reachedRows[reachedRows.length - 1]!.tier : null;
  const firstMissed = rows.find((r) => !r.reached) ?? null;
  const next =
    post50 !== null && firstMissed ? { tier: firstMissed.tier, limit: firstMissed.limit, need: Math.max(1, Math.ceil(post50 - firstMissed.limit - ON_LIMIT)) } : null;
  const top = rows[rows.length - 1];
  const spare = post50 !== null && top && !firstMissed ? Math.max(0, Math.floor(top.limit - post50 + ON_LIMIT)) : null;
  return { rows, hit, next, spare };
}

// ---------------------------------------------------------------------------------------------
// Rebate and the cost cap
// ---------------------------------------------------------------------------------------------

export interface Rebate {
  /** The tier's amount (0 below the lowest tier). */
  tierAmount: number;
  /** What the program pays: the tier amount or the cost cap, whichever is lower. */
  amount: number;
  /** The cap in dollars when a price and a cap percent were both given. */
  cap: number | null;
  /** True when the cap is what limits the rebate. */
  capped: boolean;
}

/** Floors to the cent, so a capped rebate never shows more than the program pays. */
const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;

/** The air sealing rebate: the tier amount or cap % of the installed price, whichever is lower. */
export function rebateFor(hit: RebateTier | null, program: Pick<RebateProgram, 'costCapPct'>, price: number | null): Rebate {
  const tierAmount = hit ? hit.rebate : 0;
  const cap = price !== null && price > 0 && program.costCapPct !== null ? floorCents((price * program.costCapPct) / 100) : null;
  if (!hit || cap === null || cap >= tierAmount) return { tierAmount, amount: tierAmount, cap, capped: false };
  return { tierAmount, amount: cap, cap, capped: true };
}

// ---------------------------------------------------------------------------------------------
// Ventilation (BAS)
// ---------------------------------------------------------------------------------------------

/** Stories and the BPI height correction factor for each. */
export const STORIES = [
  { value: '1', label: '1', correction: 1 },
  { value: '1.5', label: '1.5', correction: 0.89 },
  { value: '2', label: '2', correction: 0.81 },
  { value: '2.5', label: '2.5', correction: 0.76 },
  { value: '3', label: '3', correction: 0.72 },
] as const;
export type Stories = (typeof STORIES)[number]['value'];
export const DEFAULT_STORIES: Stories = '2';

export const isStories = (v: unknown): v is Stories => STORIES.some((s) => s.value === v);
export const heightCorrection = (s: Stories): number => STORIES.find((x) => x.value === s)!.correction;

/** Cubic feet per minute per person (ASHRAE 62-89, as BPI uses it). */
export const CFM_PER_PERSON = 15;
/** Air changes per hour the house needs (ASHRAE 62-89). */
export const ACH_NATURAL = 0.35;

export interface BasInputs {
  /** The Building Airflow Standard from the energy audit, in CFM50 (preferred). */
  audit: number | null;
  volume: number | null;
  occupants: number | null;
  stories: Stories;
  nFactor: number | null;
}

export type BasResult =
  | { source: 'audit' | 'estimated'; value: number }
  | { source: null; value: null; /** Why it could not be estimated, for the screen. */ missing: 'volume' | 'n-factor' | 'nothing' };

/** The BAS: from the audit when given, else estimated from the house. */
export function basFor(b: BasInputs): BasResult {
  if (b.audit !== null && b.audit > 0) return { source: 'audit', value: b.audit };
  if (b.volume === null || !(b.volume > 0)) return { source: null, value: null, missing: b.occupants !== null && b.occupants > 0 ? 'volume' : 'nothing' };
  if (b.nFactor === null || !(b.nFactor > 0)) return { source: null, value: null, missing: 'n-factor' };
  const airflow = Math.max((ACH_NATURAL * b.volume) / 60, b.occupants !== null && b.occupants > 0 ? CFM_PER_PERSON * b.occupants : 0);
  const value = airflow * b.nFactor * heightCorrection(b.stories);
  return Number.isFinite(value) && value > 0 ? { source: 'estimated', value } : { source: null, value: null, missing: 'nothing' };
}

/** BPI: under this share of the BAS, mechanical ventilation must be installed with the job. */
export const INSTALL_BELOW = 0.7;

export type VentilationStatus =
  /** Test-out at or above the BAS. */
  | { status: 'ok'; ratio: number; margin: number }
  /** From 70% up to the BAS: recommend continuous mechanical ventilation, sized for the gap. */
  | { status: 'recommend'; ratio: number; gap: number }
  /** Under 70% of the BAS: install it with the job, sized for 100% of the requirement. */
  | { status: 'install'; ratio: number; gap: number };

export function ventilation(post50: number, bas: number): VentilationStatus | null {
  if (!(post50 > 0) || !(bas > 0)) return null;
  const ratio = post50 / bas;
  if (post50 >= bas - bas * ON_LIMIT) return { status: 'ok', ratio, margin: post50 - bas };
  if (post50 >= INSTALL_BELOW * bas - bas * ON_LIMIT) return { status: 'recommend', ratio, gap: bas - post50 };
  return { status: 'install', ratio, gap: bas - post50 };
}
