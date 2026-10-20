import type { AccessLevel, Coefficient, CoefficientSet, CoeffKind, JobType, ProductCode } from './types';
import { PricingConfigError } from './types';

export interface CoeffScope {
  product?: ProductCode | null;
  jobType?: JobType | null;
  accessLevel?: AccessLevel | null;
}

/**
 * Finds the most specific coefficient that matches a scope.
 *
 * A coefficient field that is null is a wildcard. A non-null field must equal the scope's
 * value. Among matches, the one with the most non-null fields wins, so
 * (cellulose, attic) beats (cellulose, *) beats (*, *). This is the same fallback order
 * the learning loop uses for shrinkage, so a thin cell never leaves pricing without a value.
 */
export function findCoefficient(set: CoefficientSet, kind: CoeffKind, scope: CoeffScope): Coefficient | null {
  let best: Coefficient | null = null;
  let bestScore = -1;
  for (const c of set.coefficients) {
    if (c.kind !== kind) continue;
    if (c.product !== null && c.product !== (scope.product ?? null)) continue;
    if (c.jobType !== null && c.jobType !== (scope.jobType ?? null)) continue;
    if (c.accessLevel !== null && c.accessLevel !== (scope.accessLevel ?? null)) continue;
    const score = (c.product ? 1 : 0) + (c.jobType ? 1 : 0) + (c.accessLevel ? 1 : 0);
    if (score > bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Like findCoefficient, but a missing or invalid value is a configuration error. */
export function coeff(set: CoefficientSet, kind: CoeffKind, scope: CoeffScope): number {
  const c = findCoefficient(set, kind, scope);
  if (!c) {
    throw new PricingConfigError(
      `Missing coefficient ${kind} for ${[scope.product, scope.jobType, scope.accessLevel].filter(Boolean).join('/') || 'global'}`,
    );
  }
  if (!Number.isFinite(c.value) || c.value <= 0) {
    throw new PricingConfigError(`Coefficient ${kind} has invalid value ${c.value}`);
  }
  return c.value;
}
