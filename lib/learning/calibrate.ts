// SKELETON: replaced by the implementation. Signatures are the contract.
import type { CalibrationInput, CalibrationResult } from './types';

/**
 * Recomputes coefficients from completed-job observations (PLAN.md §6.3) and runs every
 * guardrail (§6.4). Pure and deterministic for a given input (including `now`).
 */
export function calibrate(input: CalibrationInput): CalibrationResult {
  void input;
  throw new Error('not implemented');
}
