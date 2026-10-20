// The public surface of lib/learning (PLAN.md §6.7): the pure modules only, safe to import from
// client components and the offline app. The database adapter (io.ts) and the nightly job
// (nightly.ts) are server-only and imported by path.
export type * from './types';
export { calibrate } from './calibrate';
export { DEFAULT_LEARNING_SETTINGS, normalizeLearningSettings, parseLearningSettings } from './settings';
export { estimateAccuracy, type AccuracyReport } from './accuracy';
export { predictWin, recommendPrice, trainWinModel, winRateBuckets } from './winRate';
export { computeDeviationFlags, deviationOutcome } from './deviation';
export {
  observationsFromJob,
  winObservationFromQuote,
  type ActualRow,
  type JobForLearning,
  type QuoteOutcomeRow,
} from './observations';
