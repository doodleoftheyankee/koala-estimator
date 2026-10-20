// Guardrails (PLAN.md §6.4): "model updates never break pricing". Applied per coefficient, in
// this order: minimum evidence, step limit, hard bounds, sanity.
import type { LearningSettings } from './types';

export interface GuardrailInput {
  /** The active value, or for a new cell the value pricing used until now (its parent's). */
  active: number;
  /** The shrunk estimate from the data; null when there is none. */
  estimate: number | null;
  nEff: number;
  lowerBound: number;
  upperBound: number;
}

export interface GuardrailOutcome {
  value: number;
  /** Too little evidence (or no estimate): the active value is kept. */
  held: boolean;
  wasStepLimited: boolean;
  wasClamped: boolean;
  /** False when the guarded value was non-finite or <= 0 and the active value was kept instead. */
  sane: boolean;
}

/** Clamps to [v0 · (1 − maxStepPct), v0 · (1 + maxStepPct)]. No limit when v0 is not a positive number. */
export function stepLimit(value: number, v0: number, maxStepPct: number): { value: number; limited: boolean } {
  if (!(v0 > 0) || !Number.isFinite(v0) || Number.isNaN(value)) return { value, limited: false };
  const lo = v0 * (1 - maxStepPct);
  const hi = v0 * (1 + maxStepPct);
  if (value < lo) return { value: lo, limited: true };
  if (value > hi) return { value: hi, limited: true };
  return { value, limited: false };
}

/** Clamps to [lowerBound, upperBound]. */
export function clampToBounds(value: number, lowerBound: number, upperBound: number): { value: number; clamped: boolean } {
  if (Number.isNaN(value)) return { value, clamped: false };
  if (value < lowerBound) return { value: lowerBound, clamped: true };
  if (value > upperBound) return { value: upperBound, clamped: true };
  return { value, clamped: false };
}

/** What the sanity gate demands of every coefficient in a candidate set. */
export function isSaneValue(value: number, lowerBound: number, upperBound: number): boolean {
  return Number.isFinite(value) && value > 0 && value >= lowerBound && value <= upperBound;
}

export function applyGuardrails(
  g: GuardrailInput,
  s: Pick<LearningSettings, 'minNEff' | 'maxStepPct'>,
): GuardrailOutcome {
  const keep = { value: g.active, wasStepLimited: false, wasClamped: false };
  if (g.estimate === null || !(g.nEff >= s.minNEff)) return { ...keep, held: true, sane: true };

  const step = stepLimit(g.estimate, g.active, s.maxStepPct);
  const bounded = clampToBounds(step.value, g.lowerBound, g.upperBound);
  if (!Number.isFinite(bounded.value) || bounded.value <= 0) return { ...keep, held: false, sane: false };
  return {
    value: bounded.value,
    held: false,
    wasStepLimited: step.limited,
    wasClamped: bounded.clamped,
    sane: true,
  };
}
