// SKELETON: replaced by the implementation. Signatures are the contract.
import type { EstimateInput, PricedEstimate, PricingBundle } from '@/lib/pricing';
import type { DeviationFlag, DeviationOutcome } from './types';

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
  void priced;
  void input;
  void bundle;
  throw new Error('not implemented');
}

/** After the job: who was closer to the actual value? Within 2% of each other is a tie. */
export function deviationOutcome(estimatorValue: number, modelValue: number, actualValue: number): DeviationOutcome {
  void estimatorValue;
  void modelValue;
  void actualValue;
  throw new Error('not implemented');
}
