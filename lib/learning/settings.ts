// Learning-loop settings (app_settings.learning, snake_case JSON). Anything missing or
// nonsensical falls back to the default, so a bad admin edit can never break the nightly run.
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

type NumericKey = Exclude<keyof LearningSettings, 'autoPromote'>;

/** Snake_case key in app_settings.learning and the range that makes sense for each number. */
const NUMERIC: Record<NumericKey, { key: string; ok: (n: number) => boolean; fix?: (n: number) => number }> = {
  halfLifeDays: { key: 'half_life_days', ok: (n) => n > 0 },
  shrinkageK: { key: 'shrinkage_k', ok: (n) => n >= 0 },
  minNEff: { key: 'min_n_eff', ok: (n) => n >= 0 },
  maxStepPct: { key: 'max_step_pct', ok: (n) => n >= 0 },
  holdoutFrac: { key: 'holdout_frac', ok: (n) => n > 0 && n < 1 },
  winsorPct: { key: 'winsor_pct', ok: (n) => n >= 0 && n < 0.5 },
  minQuotesForWinModel: { key: 'min_quotes_for_win_model', ok: (n) => n >= 1, fix: Math.ceil },
  winHalfLifeDays: { key: 'win_half_life_days', ok: (n) => n > 0 },
  winL2: { key: 'win_l2', ok: (n) => n >= 0 },
};

const NUMERIC_KEYS = Object.keys(NUMERIC) as NumericKey[];

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

function toBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function numeric(k: NumericKey, v: unknown): number {
  const rule = NUMERIC[k];
  const n = toNumber(v);
  if (!Number.isFinite(n) || !rule.ok(n)) return DEFAULT_LEARNING_SETTINGS[k];
  return rule.fix ? rule.fix(n) : n;
}

function build(read: (k: NumericKey) => unknown, autoPromote: unknown): LearningSettings {
  const out = { ...DEFAULT_LEARNING_SETTINGS, autoPromote: toBoolean(autoPromote) ?? DEFAULT_LEARNING_SETTINGS.autoPromote };
  for (const k of NUMERIC_KEYS) out[k] = numeric(k, read(k));
  return out;
}

/** Replaces every out-of-range or non-finite field with its default (calibrate runs this first). */
export function normalizeLearningSettings(s: LearningSettings): LearningSettings {
  return build((k) => s[k], s.autoPromote);
}

/** Parses app_settings.learning (snake_case JSON) with defaults for missing keys. */
export function parseLearningSettings(value: unknown): LearningSettings {
  let raw = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  const obj: Record<string, unknown> =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return build((k) => obj[NUMERIC[k].key], obj.auto_promote);
}
