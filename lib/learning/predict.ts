// Model predictions for learning, using exactly the engine's coefficient lookup
// (findCoefficient: most specific matching scope wins, null = wildcard) and formulas.
import { findCoefficient, type CoefficientSet, type CoeffKind } from '@/lib/pricing';
import type { CoeffScope } from '@/lib/pricing/coefficients';
import type { Observation, StoredCoefficient } from './types';

/** Amounts outside this range are data-entry errors, not jobs (and would overflow the math). */
export const MIN_AMOUNT = 1e-6;
export const MAX_AMOUNT = 1e9;

/** The amount when it is finite and within [MIN_AMOUNT, MAX_AMOUNT], else null. */
export const usableAmount = (n: number | null): number | null =>
  n !== null && Number.isFinite(n) && n >= MIN_AMOUNT && n <= MAX_AMOUNT ? n : null;

/** Maps stored coefficients to the engine's CoefficientSet (same order, same values). */
export function toCoefficientSet(coeffs: readonly StoredCoefficient[], id = 'learning'): CoefficientSet {
  return {
    id,
    version: 0,
    coefficients: coeffs.map((c) => ({
      kind: c.kind,
      product: c.product,
      jobType: c.jobType,
      accessLevel: c.accessLevel,
      value: c.value,
      sampleSize: c.sampleSize,
      nEff: c.nEff,
      confidence: c.confidence,
    })),
  };
}

/** The stored coefficient the engine would use for this scope, or null. */
export function findStored<T extends StoredCoefficient>(list: readonly T[], kind: CoeffKind, scope: CoeffScope): T | null {
  const set = toCoefficientSet(list);
  const hit = findCoefficient(set, kind, scope);
  return hit ? (list[set.coefficients.indexOf(hit)] ?? null) : null;
}

const value = (set: CoefficientSet, kind: CoeffKind, scope: CoeffScope): number | null =>
  findCoefficient(set, kind, scope)?.value ?? null;

/**
 * Person-hours the model predicts for an observation:
 *  - removal: setup(removal) + sqft × removal_hrs_per_sqft(job type) × access
 *  - others:  setup(product, job type) + designQty × labor_hrs_per_unit(product, job type) × access
 * Null when a required coefficient is missing (the engine would refuse to price it) or a
 * quantity is not a usable amount.
 */
export function predictHours(set: CoefficientSet, o: Observation): number | null {
  const access = value(set, 'access_mult', { accessLevel: o.accessLevel });
  if (access === null) return null;
  if (o.product === 'removal') {
    const rate = value(set, 'removal_hrs_per_sqft', { jobType: o.jobType });
    const sqft = usableAmount(o.sqft);
    if (rate === null || sqft === null) return null;
    return (value(set, 'setup_hours', { product: 'removal' }) ?? 0) + sqft * rate * access;
  }
  const designQty = usableAmount(o.designQty);
  if (designQty === null) return null;
  const scope = { product: o.product, jobType: o.jobType };
  const rate = value(set, 'labor_hrs_per_unit', scope);
  if (rate === null) return null;
  return (value(set, 'setup_hours', scope) ?? 0) + designQty * rate * access;
}

/**
 * Material the model predicts: designQty × waste_factor(product, job type), unrounded.
 * Air sealing without a waste factor uses 1, as the engine does. Null for removal rows.
 */
export function predictQty(set: CoefficientSet, o: Observation): number | null {
  const designQty = usableAmount(o.designQty);
  if (o.product === 'removal' || designQty === null) return null;
  const waste =
    value(set, 'waste_factor', { product: o.product, jobType: o.jobType }) ?? (o.product === 'air_sealing' ? 1 : null);
  return waste === null ? null : designQty * waste;
}
