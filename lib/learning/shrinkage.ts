// Hierarchical shrinkage (PLAN.md §6.3): a thin cell leans on its parent, a cell with plenty
// of data converges to its own mean. k is the number of pseudo-observations at the parent value.

/** n_eff / (n_eff + k): how much of the cell's own mean survives. 1 when k = 0 and there is evidence. */
export function shrinkWeight(nEff: number, k: number): number {
  const d = nEff + k;
  return nEff > 0 && d > 0 ? nEff / d : 0;
}

/**
 * est = (n_eff · mean + k · parent) / (n_eff + k). Falls back to the parent when the cell has
 * no mean or no evidence.
 */
export function shrink(mean: number | null, nEff: number, parent: number, k: number): number {
  if (mean === null) return parent;
  const f = shrinkWeight(nEff, k);
  return f === 1 ? mean : f === 0 ? parent : f * mean + (1 - f) * parent;
}
