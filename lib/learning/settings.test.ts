import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LEARNING_SETTINGS, normalizeLearningSettings, parseLearningSettings } from './settings';
import type { LearningSettings } from './types';

const valid = (s: LearningSettings) => {
  expect(s.halfLifeDays).toBeGreaterThan(0);
  expect(s.shrinkageK).toBeGreaterThanOrEqual(0);
  expect(s.minNEff).toBeGreaterThanOrEqual(0);
  expect(s.maxStepPct).toBeGreaterThanOrEqual(0);
  expect(s.holdoutFrac).toBeGreaterThan(0);
  expect(s.holdoutFrac).toBeLessThan(1);
  expect(s.winsorPct).toBeGreaterThanOrEqual(0);
  expect(s.winsorPct).toBeLessThan(0.5);
  expect(Number.isInteger(s.minQuotesForWinModel) && s.minQuotesForWinModel >= 1).toBe(true);
  expect(s.winHalfLifeDays).toBeGreaterThan(0);
  expect(s.winL2).toBeGreaterThanOrEqual(0);
  expect(typeof s.autoPromote).toBe('boolean');
  for (const v of Object.values(s)) if (typeof v === 'number') expect(Number.isFinite(v)).toBe(true);
};

describe('parseLearningSettings', () => {
  it('reads the seeded snake_case JSON', () => {
    const seeded = {
      half_life_days: 180,
      shrinkage_k: 5,
      min_n_eff: 3,
      max_step_pct: 0.1,
      holdout_frac: 0.2,
      winsor_pct: 0.05,
      auto_promote: false,
      min_quotes_for_win_model: 40,
      win_half_life_days: 365,
      win_l2: 1.0,
      price_recommendations: true,
    };
    expect(parseLearningSettings(seeded)).toEqual(DEFAULT_LEARNING_SETTINGS);
  });

  it('reads every key', () => {
    expect(
      parseLearningSettings({
        half_life_days: 90,
        shrinkage_k: 2,
        min_n_eff: 4,
        max_step_pct: 0.05,
        holdout_frac: 0.25,
        winsor_pct: 0.1,
        auto_promote: true,
        min_quotes_for_win_model: 60,
        win_half_life_days: 200,
        win_l2: 0.5,
      }),
    ).toEqual({
      halfLifeDays: 90,
      shrinkageK: 2,
      minNEff: 4,
      maxStepPct: 0.05,
      holdoutFrac: 0.25,
      winsorPct: 0.1,
      autoPromote: true,
      minQuotesForWinModel: 60,
      winHalfLifeDays: 200,
      winL2: 0.5,
    });
  });

  it('falls back to defaults for anything that is not an object', () => {
    for (const v of [null, undefined, 42, [], 'nope', '{bad json', '[1,2]']) {
      expect(parseLearningSettings(v)).toEqual(DEFAULT_LEARNING_SETTINGS);
    }
  });

  it('accepts a JSON string, numeric strings and boolean strings', () => {
    expect(parseLearningSettings('{"half_life_days": 120, "auto_promote": "true"}')).toMatchObject({ halfLifeDays: 120, autoPromote: true });
    expect(parseLearningSettings({ max_step_pct: '0.15', auto_promote: 'false' })).toMatchObject({ maxStepPct: 0.15, autoPromote: false });
  });

  it('replaces nonsensical values with defaults', () => {
    const d = DEFAULT_LEARNING_SETTINGS;
    expect(
      parseLearningSettings({
        half_life_days: 0,
        shrinkage_k: -1,
        min_n_eff: 'many',
        max_step_pct: -0.1,
        holdout_frac: 1,
        winsor_pct: 0.5,
        auto_promote: 'yes',
        min_quotes_for_win_model: 0,
        win_half_life_days: -3,
        win_l2: Number.NaN,
      }),
    ).toEqual(d);
    expect(parseLearningSettings({ half_life_days: '', holdout_frac: 0, winsor_pct: -0.01 })).toEqual(d);
    expect(parseLearningSettings({ half_life_days: Number.POSITIVE_INFINITY })).toEqual(d);
  });

  it('keeps edge values that still make sense and rounds the quote count up', () => {
    expect(parseLearningSettings({ shrinkage_k: 0, min_n_eff: 0, max_step_pct: 0, winsor_pct: 0, win_l2: 0, min_quotes_for_win_model: 40.2 })).toMatchObject({
      shrinkageK: 0,
      minNEff: 0,
      maxStepPct: 0,
      winsorPct: 0,
      winL2: 0,
      minQuotesForWinModel: 41,
    });
  });

  it('always returns usable settings (property)', () => {
    fc.assert(fc.property(fc.anything(), (v) => valid(parseLearningSettings(v))));
    fc.assert(
      fc.property(
        fc.record({
          half_life_days: fc.oneof(fc.double(), fc.string()),
          shrinkage_k: fc.double(),
          min_n_eff: fc.double(),
          max_step_pct: fc.double(),
          holdout_frac: fc.double(),
          winsor_pct: fc.double(),
          auto_promote: fc.anything(),
          min_quotes_for_win_model: fc.double(),
          win_half_life_days: fc.double(),
          win_l2: fc.double(),
        }),
        (v) => valid(parseLearningSettings(v)),
      ),
    );
  });
});

describe('normalizeLearningSettings', () => {
  it('keeps good settings and repairs bad ones', () => {
    const good: LearningSettings = { ...DEFAULT_LEARNING_SETTINGS, halfLifeDays: 30, autoPromote: true };
    expect(normalizeLearningSettings(good)).toEqual(good);
    expect(normalizeLearningSettings({ ...good, halfLifeDays: Number.NaN, maxStepPct: -1, holdoutFrac: 2 })).toEqual({
      ...good,
      halfLifeDays: DEFAULT_LEARNING_SETTINGS.halfLifeDays,
      maxStepPct: DEFAULT_LEARNING_SETTINGS.maxStepPct,
      holdoutFrac: DEFAULT_LEARNING_SETTINGS.holdoutFrac,
    });
  });
});
