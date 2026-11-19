import { describe, expect, it } from 'vitest';
import { SEEDED } from './__fixtures__/settings';
import { EMPTY_SETTINGS, formatEffectiveDate, newProgramKey, parseBlowerDoorSettings, toStored, validateBlowerDoorSettings, type StoredSettings } from './settings';

const clone = (): StoredSettings => structuredClone(SEEDED);

describe('reading the stored settings (the tool)', () => {
  it('reads the seeded programs, lowest tier first', () => {
    const { settings, problems } = parseBlowerDoorSettings(SEEDED);
    expect(problems).toEqual([]);
    expect(settings.gauge).toBe('Retrotec Model 5000');
    expect(settings.flowExponent).toBe(0.65);
    expect(settings.nFactor).toBe(19);
    expect(settings.programs.map((p) => [p.key, p.label, p.tiers.map((t) => t.rebate)])).toEqual([
      ['home_performance', 'Home Performance', [900, 1300, 1800]],
      ['assisted', 'Assisted', [1100, 1500, 2000]],
    ]);
    expect(settings.programs[0]).toMatchObject({ costCapPct: 75, mechVentRebateCap: 400, effectiveDate: '2024-11-01' });
    expect(toStored(settings)).toEqual(SEEDED);
  });

  it('opens with defaults and no programs when nothing is set up', () => {
    expect(parseBlowerDoorSettings(null)).toEqual({ settings: EMPTY_SETTINGS, problems: [] });
    expect(parseBlowerDoorSettings(undefined).settings.programs).toEqual([]);
    expect(parseBlowerDoorSettings('nonsense')).toEqual({ settings: EMPTY_SETTINGS, problems: ['The blower door settings could not be read.'] });
    expect(parseBlowerDoorSettings({}).settings).toEqual(EMPTY_SETTINGS);
  });

  it('replaces a bad value with its default and leaves out a program that makes no sense, saying which', () => {
    const s = clone() as unknown as Record<string, unknown>;
    s.flow_exponent = 7;
    (s.programs as Array<Record<string, unknown>>)[1]!.tiers = [{ reduction_pct: 30, rebate: 1500 }, { reduction_pct: 20, rebate: 1100 }];
    const { settings, problems } = parseBlowerDoorSettings(s);
    expect(settings.flowExponent).toBe(0.65);
    expect(settings.programs.map((p) => p.key)).toEqual(['home_performance']);
    expect(problems).toEqual(['The flow exponent was not valid; using 0.65.', 'Assisted was left out: Assisted: tiers must go up in reduction, lowest first (30% then 20%).']);
  });

  it('leaves out a second program with the same key', () => {
    const s = clone();
    s.programs[1]!.key = 'home_performance';
    const { settings, problems } = parseBlowerDoorSettings(s);
    expect(settings.programs).toHaveLength(1);
    expect(problems).toEqual(['Assisted was left out: another program has the same key.']);
  });

  it('fills in optional parts an older copy may not have', () => {
    const s = clone() as unknown as { programs: Array<Record<string, unknown>> };
    delete s.programs[0]!.paperwork;
    delete s.programs[0]!.cost_cap_pct;
    delete s.programs[0]!.effective_date;
    delete s.programs[0]!.source;
    delete s.programs[0]!.paperwork_source;
    delete s.programs[0]!.mech_vent_rebate_cap;
    const { settings, problems } = parseBlowerDoorSettings(s);
    expect(problems).toEqual([]);
    expect(settings.programs[0]).toMatchObject({ key: 'home_performance', paperwork: [], costCapPct: null, effectiveDate: null, source: '', paperworkSource: '', mechVentRebateCap: null });
  });
});

describe('saving settings (the Rebate programs page)', () => {
  it('accepts the seeded settings and returns what to store', () => {
    const r = validateBlowerDoorSettings(SEEDED);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(SEEDED);
  });

  it('accepts no programs at all', () => {
    expect(validateBlowerDoorSettings({ ...clone(), programs: [] }).ok).toBe(true);
  });

  it('tidies spaces in names', () => {
    const s = clone();
    s.programs[0]!.label = '  Home   Performance ';
    const r = validateBlowerDoorSettings(s);
    expect(r.ok && r.value.programs[0]!.label).toBe('Home Performance');
  });

  const fails = (mutate: (s: StoredSettings) => void): string[] => {
    const s = clone();
    mutate(s);
    const r = validateBlowerDoorSettings(s);
    expect(r.ok).toBe(false);
    return r.ok ? [] : r.errors;
  };

  it('wants tiers in ascending order', () => {
    expect(
      fails((s) => {
        s.programs[0]!.tiers = [
          { reduction_pct: 20, rebate: 900 },
          { reduction_pct: 20, rebate: 1300 },
        ];
      }),
    ).toEqual(['Program 1: tiers must go up in reduction, lowest first (20% then 20%).']);
  });

  it('wants a higher tier to pay at least as much', () => {
    expect(
      fails((s) => {
        s.programs[0]!.tiers[2]!.rebate = 1000;
      }),
    ).toEqual(['Program 1: a higher tier cannot pay less than a lower one ($1300 then $1000).']);
  });

  it('wants whole dollars', () => {
    expect(fails((s) => void (s.programs[1]!.tiers[0]!.rebate = 900.5))).toEqual(["Program 2: a tier's rebate must be whole dollars (no cents)."]);
    expect(fails((s) => void (s.programs[1]!.mech_vent_rebate_cap = 400.25))).toEqual(['Program 2: the ventilation rebate must be whole dollars (no cents).']);
    expect(fails((s) => void (s.programs[1]!.tiers[0]!.rebate = -5))).toEqual(["Program 2: a tier's rebate cannot be negative."]);
  });

  it('wants percentages between 0 and 100', () => {
    expect(fails((s) => void (s.programs[0]!.tiers[0]!.reduction_pct = 0))).toEqual(["Program 1: a tier's reduction must be more than 0%."]);
    expect(
      fails((s) => {
        s.programs[0]!.tiers = [{ reduction_pct: 100, rebate: 900 }];
      }),
    ).toEqual(["Program 1: a tier's reduction must be less than 100%."]);
    expect(fails((s) => void (s.programs[0]!.cost_cap_pct = 120))).toEqual(['Program 1: the cost cap must be at most 100%.']);
    expect(fails((s) => void (s.programs[0]!.cost_cap_pct = 0))).toEqual(['Program 1: the cost cap must be more than 0%.']);
  });

  it('wants a tier, names, a real date, unique keys and short names', () => {
    expect(fails((s) => void (s.programs[0]!.tiers = []))).toEqual(['Program 1: add at least one tier.']);
    expect(fails((s) => void (s.programs[0]!.label = '  '))).toEqual(['Program 1: the short name is missing.']);
    expect(fails((s) => void (s.programs[0]!.effective_date = '2024-02-30'))).toEqual(['Program 1: the effective date must be a real date.']);
    expect(fails((s) => void (s.programs[1]!.label = 'home performance'))).toEqual(['Two programs have the same short name (home performance).']);
    expect(fails((s) => void (s.programs[1]!.key = 'home_performance'))).toEqual(['Two programs have the same key (home_performance).']);
    expect(fails((s) => void (s.programs[1]!.key = 'Bad Key!'))).toEqual(['Program 2: its key must be lower-case letters, digits, - or _.']);
  });

  it('wants a gauge name and sane defaults', () => {
    expect(fails((s) => void (s.gauge = ''))).toEqual(['The gauge name is missing.']);
    expect(fails((s) => void (s.flow_exponent = 1.5))).toEqual(['The flow exponent must be between 0.5 and 1.']);
    expect(fails((s) => void (s.n_factor = 0))).toEqual(['The N-factor must be between 1 and 40.']);
  });

  it('lets a program have no cost cap and no ventilation rebate', () => {
    const s = clone();
    s.programs[0]!.cost_cap_pct = null;
    s.programs[0]!.mech_vent_rebate_cap = null;
    s.programs[0]!.effective_date = null;
    expect(validateBlowerDoorSettings(s).ok).toBe(true);
  });
});

describe('helpers', () => {
  it('makes a key for a new program that no other uses', () => {
    expect(newProgramKey('Assisted', [])).toBe('assisted');
    expect(newProgramKey('Assisted', ['assisted', 'assisted-2'])).toBe('assisted-3');
    expect(newProgramKey('Home Perf. (2026)', [])).toBe('home-perf-2026');
    expect(newProgramKey('★', [])).toBe('program');
  });

  it('shows an effective date as a calendar date, whatever the time zone', () => {
    expect(formatEffectiveDate('2024-11-01')).toBe('Nov 1, 2024');
    expect(formatEffectiveDate('2024-13-01')).toBeNull();
    expect(formatEffectiveDate(null)).toBeNull();
  });
});
