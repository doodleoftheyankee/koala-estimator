// Estimate accuracy for the dashboard and the weekly report: how close the model and the
// estimator came to what the crew actually used and worked.
import type { Observation } from './types';

export interface AccuracyReport {
  n: number; // observations that entered at least one of the four errors
  hoursMapeModel: number | null; // mean |model - actual| / actual over observations with both
  hoursMapeEstimator: number | null;
  qtyMapeModel: number | null;
  qtyMapeEstimator: number | null;
}

class Mape {
  private sum = 0;
  private n = 0;
  /** Adds one row; false when there is no prediction to compare. */
  add(predicted: number | null, actual: number): boolean {
    if (predicted === null || !Number.isFinite(predicted)) return false;
    this.sum += Math.abs(predicted - actual) / actual;
    this.n++;
    return true;
  }
  value(): number | null {
    return this.n > 0 ? this.sum / this.n : null;
  }
}

const positive = (n: number | null): n is number => n !== null && Number.isFinite(n) && n > 0;

/** Estimate accuracy for the dashboard and weekly report. Ignores rows with actual <= 0. */
export function estimateAccuracy(observations: Observation[]): AccuracyReport {
  const hoursModel = new Mape();
  const hoursEst = new Mape();
  const qtyModel = new Mape();
  const qtyEst = new Mape();
  let n = 0;
  for (const o of observations) {
    // Every add() runs: a short-circuiting `||` would skip the estimator once the model counted.
    const used = [
      positive(o.actualHours) && hoursModel.add(o.modelHours, o.actualHours),
      positive(o.actualHours) && hoursEst.add(o.estHours, o.actualHours),
      positive(o.actualQty) && qtyModel.add(o.modelQty, o.actualQty),
      positive(o.actualQty) && qtyEst.add(o.estQty, o.actualQty),
    ];
    if (used.some(Boolean)) n++;
  }
  return {
    n,
    hoursMapeModel: hoursModel.value(),
    hoursMapeEstimator: hoursEst.value(),
    qtyMapeModel: qtyModel.value(),
    qtyMapeEstimator: qtyEst.value(),
  };
}
