// SKELETON: replaced by the implementation. Signatures are the contract.
import type { Observation } from './types';

export interface AccuracyReport {
  n: number;
  hoursMapeModel: number | null; // mean |model - actual| / actual over observations with both
  hoursMapeEstimator: number | null;
  qtyMapeModel: number | null;
  qtyMapeEstimator: number | null;
}

/** Estimate accuracy for the dashboard and weekly report. Ignores rows with actual <= 0. */
export function estimateAccuracy(observations: Observation[]): AccuracyReport {
  void observations;
  throw new Error('not implemented');
}
