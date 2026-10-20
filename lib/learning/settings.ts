// SKELETON: replaced by the implementation. Signatures are the contract.
import type { LearningSettings } from './types';

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
  halfLifeDays: 180,
  shrinkageK: 5,
  minNEff: 3,
  maxStepPct: 0.1,
  holdoutFrac: 0.2,
  winsorPct: 0.05,
  autoPromote: false,
  minQuotesForWinModel: 40,
  winHalfLifeDays: 365,
  winL2: 1,
};

/** Parses app_settings.learning (snake_case JSON) with defaults for missing keys. */
export function parseLearningSettings(value: unknown): LearningSettings {
  void value;
  throw new Error('not implemented');
}
