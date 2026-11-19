import { describe, expect, it } from 'vitest';
import { SEEDED } from './__fixtures__/settings';
import {
  ach50,
  basFor,
  emptyForm,
  evaluate,
  evaluateTiers,
  headlineWords,
  nextTierLine,
  readField,
  readNumber,
  rebateFor,
  reductionPct,
  reviveForm,
  RULES,
  summaryText,
  toCfm50,
  ventilation,
  ventilationWords,
  sourceLine,
  capNote,
  basMissingText,
  cfmText,
  nFactorHint,
  parseBlowerDoorSettings,
  shownNumbers,
  ventilationFor,
  type BlowerDoorForm,
  type BlowerDoorSettings,
  type Evaluation,
} from './index';

const SETTINGS: BlowerDoorSettings = parseBlowerDoorSettings(SEEDED).settings;
const NO_PROGRAMS: BlowerDoorSettings = { ...SETTINGS, programs: [] };

/** A form with the given fields typed in. */
const form = (patch: Partial<BlowerDoorForm>, settings = SETTINGS): BlowerDoorForm => ({ ...emptyForm(settings), ...patch });
const run = (patch: Partial<BlowerDoorForm>, settings = SETTINGS): Evaluation => evaluate({ form: form(patch, settings), settings });

/** The owner's worked example: 6,952 CFM at 50 Pa in, 3,325 CFM at 50.8 Pa out, n 0.65. */
const WORKED = { preCfm: '6952', prePa: '50', postCfm: '3325', postPa: '50.8' };

describe('reading what was typed', () => {
  it('drops $, commas, spaces and the sign (a gauge shows negative pressure)', () => {
    expect(readNumber('$1,234')).toBe(1234);
    expect(readNumber('-50.8')).toBe(50.8);
    expect(readNumber(' 6 952 ')).toBe(6952);
    expect(readNumber('.5')).toBe(0.5);
    expect(readNumber('')).toBeNull();
    expect(readNumber(null)).toBeNull();
  });

  it('calls anything else not a number, never NaN on screen', () => {
    // A lone '-' is someone starting to type "-50": not typed yet (see BD-R8 below).
    for (const t of ['abc', '1.2.3', '12a', '1e5', '--5']) {
      expect(Number.isNaN(readNumber(t)), t).toBe(true);
      expect(readField(t, RULES.cfm)).toEqual({ state: 'invalid', error: 'Fan flow: type a number.' });
    }
  });

  it('refuses zero and absurd values with the range in words', () => {
    expect(readField('0', RULES.cfm)).toEqual({ state: 'invalid', error: 'Fan flow must be more than 0 CFM and at most 50,000 CFM.' });
    expect(readField('-0', RULES.cfm).state).toBe('invalid');
    expect(readField('999999', RULES.cfm).state).toBe('invalid');
    expect(readField('0', RULES.pa)).toEqual({ state: 'invalid', error: 'House pressure must be at least 1 Pa and at most 100 Pa.' });
    expect(readField('500', RULES.pa).state).toBe('invalid');
    expect(readField('2', RULES.exponent).state).toBe('invalid');
    expect(readField('2.5', RULES.occupants)).toEqual({ state: 'invalid', error: 'Occupants must be a whole number.' });
    expect(readField('$0', RULES.cost)).toEqual({ state: 'invalid', error: 'Air sealing price must be more than $0 and at most $1,000,000.' });
  });

  it('takes a negative number as its size', () => {
    expect(readField('-6952', RULES.cfm)).toEqual({ state: 'ok', value: 6952 });
    expect(readField('-50', RULES.pa)).toEqual({ state: 'ok', value: 50 });
  });
});

describe('the arithmetic', () => {
  it('converts a reading to 50 Pa with CFM × (50 ÷ Pa)^n', () => {
    expect(toCfm50(6952, 50, 0.65)).toBe(6952);
    expect(toCfm50(3325, 50.8, 0.65)).toBeCloseTo(3290.87, 2);
    expect(toCfm50(1000, 25, 0.65)).toBeCloseTo(1000 * 2 ** 0.65, 9);
    expect(toCfm50(1000, 25, 1)).toBe(2000);
  });

  it('returns null, never NaN or Infinity, for readings it cannot use', () => {
    expect(toCfm50(0, 50, 0.65)).toBeNull();
    expect(toCfm50(-100, 50, 0.65)).toBeNull();
    expect(toCfm50(100, 0, 0.65)).toBeNull();
    expect(toCfm50(100, 50, 0)).toBeNull();
    expect(toCfm50(Number.NaN, 50, 0.65)).toBeNull();
    expect(toCfm50(1e308, 1e-300, 1)).toBeNull();
    expect(reductionPct(0, 100)).toBeNull();
    expect(reductionPct(100, Number.NaN)).toBeNull();
    expect(ach50(1000, null)).toBeNull();
    expect(ach50(1000, 0)).toBeNull();
  });

  it('works out the reduction, ACH50 and a negative reduction when the test-out is higher', () => {
    expect(reductionPct(1000, 800)).toBe(20);
    expect(reductionPct(1000, 1100)).toBe(-10);
    expect(ach50(1000, 12000)).toBe(5);
  });
});

describe('the worked example', () => {
  const e = run(WORKED);

  it('gives post50 about 3,291, a 52.7% reduction, the 40% tier and $1,800 on Home Performance', () => {
    expect(e.testIn.reading!.cfm50).toBe(6952);
    expect(e.testOut.reading!.cfm50).toBeCloseTo(3290.87, 1);
    expect(e.reductionPct).toBeCloseTo(52.66, 2);
    expect(e.tiers!.hit).toEqual({ reductionPct: 40, rebate: 1800 });
    expect(e.rebate).toEqual({ tierAmount: 1800, amount: 1800, cap: null, capped: false });
    // No price typed: the most the tier pays, before the 75% cost cap (release review C DOC-4).
    expect(headlineWords(e)).toEqual({ tone: 'pass', badge: '40% TIER — UP TO $1,800 AIR SEAL REBATE', big: '52.7%', unit: null, line: '6,952 → 3,291 CFM50' });
    expect(nextTierLine(e.tiers, true)).toBe('Top tier reached with 880 CFM50 to spare.');
  });

  it('shows every tier limit and a check on the ones reached', () => {
    expect(e.tiers!.rows.map((r) => [r.tier.reductionPct, Math.round(r.limit), r.reached])).toEqual([
      [20, 5562, true],
      [30, 4866, true],
      [40, 4171, true],
    ]);
  });

  it('pays the Assisted amount on the Assisted program', () => {
    const a = run({ ...WORKED, programKey: 'assisted' });
    expect(a.program!.label).toBe('Assisted');
    expect(headlineWords(a).badge).toBe('40% TIER — UP TO $2,000 AIR SEAL REBATE');
  });

  it('also gives the reduction from the raw gauge readings', () => {
    expect(e.rawReductionPct).toBeCloseTo(((6952 - 3325) / 6952) * 100, 9);
  });

  it('copies the same summary the tool always copied', () => {
    const withHouse = run({ ...WORKED, volume: '20,000', occupants: '3', stories: '2' });
    expect(summaryText(withHouse, SETTINGS)).toBe(
      [
        'Blower Door Results (Retrotec Model 5000)',
        'Program: Energize Delaware Home Performance with ENERGY STAR',
        'Test-in: 6,952 CFM50 (read 6,952 CFM at 50 Pa)',
        'Test-out: 3,291 CFM50 (read 3,325 CFM at 50.8 Pa)',
        'Reduction: 52.7% (3,661 CFM50)',
        'Air sealing tier: 40% improvement — rebate up to $1,800 (before the 75% cost cap)',
        'BAS: 1,796 CFM50 (estimated) — above BAS, no mechanical ventilation needed',
        'ACH50: 20.86 -> 9.87',
      ].join('\n'),
    );
    expect(summaryText(withHouse, SETTINGS, 'Pat Lee, 12 Elkton Rd')!.split('\n')[1]).toBe('For: Pat Lee, 12 Elkton Rd');
  });

  it('types the pressure the same however the gauge shows it', () => {
    const neg = run({ ...WORKED, postPa: '-50.8', prePa: '-50' });
    expect(neg.testOut.reading!.cfm50).toBe(e.testOut.reading!.cfm50);
    expect(neg.reductionPct).toBe(e.reductionPct);
  });
});

describe('tiers', () => {
  const tiers = SETTINGS.programs[0]!.tiers;

  it('reaches a tier exactly on its limit', () => {
    const t = evaluateTiers(1000, 800, tiers);
    expect(t.hit).toEqual({ reductionPct: 20, rebate: 900 });
    expect(t.next).toEqual({ tier: { reductionPct: 30, rebate: 1300 }, limit: 700, need: 100 });
    const onScreen = run({ preCfm: '1000', postCfm: '800' });
    expect(headlineWords(onScreen).badge).toBe('20% TIER — UP TO $900 AIR SEAL REBATE');
    expect(nextTierLine(onScreen.tiers, true)).toBe('Need 100 more CFM50 of reduction to reach the 30% tier.');
  });

  it('reaches it on a limit worked out from decimals too', () => {
    // 30% of 6,952 is 4,866.4 (not exact in binary).
    expect(run({ preCfm: '6952', postCfm: '4866.4' }).tiers!.hit!.reductionPct).toBe(30);
  });

  it('misses it by a fraction, and asks for at least 1 more CFM50', () => {
    const t = run({ preCfm: '1000', postCfm: '800.4' });
    expect(t.tiers!.hit).toBeNull();
    // 19.96% shows as 19.9%, never 20.0% beside BELOW 20% (BD-MATH-3).
    expect(headlineWords(t)).toMatchObject({ tone: 'fail', badge: 'BELOW 20% — NO AIR SEAL REBATE YET', big: '19.9%' });
    expect(nextTierLine(t.tiers, true)).toBe('Need 1 more CFM50 of reduction to reach the 20% tier.');
    expect(t.rebate).toEqual({ tierAmount: 0, amount: 0, cap: null, capped: false });
  });

  it('handles a test-out above the test-in: a negative reduction and no rebate', () => {
    const t = run({ preCfm: '3000', postCfm: '3200' });
    expect(t.reductionPct).toBeCloseTo(-6.667, 3);
    expect(headlineWords(t)).toMatchObject({ tone: 'fail', badge: 'BELOW 20% — NO AIR SEAL REBATE YET', big: '-6.7%', line: '3,000 → 3,200 CFM50' });
    expect(nextTierLine(t.tiers, true)).toBe('Need 800 more CFM50 of reduction to reach the 20% tier.');
    expect(summaryText(t, SETTINGS)).toContain('Air sealing tier: below 20% — no rebate yet');
  });

  it('sorts tiers given out of order', () => {
    const t = evaluateTiers(1000, 650, [tiers[2]!, tiers[0]!, tiers[1]!]);
    expect(t.rows.map((r) => r.tier.reductionPct)).toEqual([20, 30, 40]);
    expect(t.hit!.reductionPct).toBe(30);
  });

  it('with only the test-in, shows the limits and what the first tier needs', () => {
    const t = run({ preCfm: '6952' });
    expect(t.headline).toEqual({ kind: 'test-in-only', pre50: 6952 });
    expect(headlineWords(t)).toEqual({ tone: 'neutral', badge: 'TEST-IN ONLY', big: '6,952', unit: 'CFM50 before', line: 'Enter the test-out after the work.' });
    expect(t.tiers!.rows.every((r) => !r.reached)).toBe(true);
    // The limit is 5,561.6: the largest whole CFM50 that reaches it is 5,561 (BD-MATH-3).
    expect(nextTierLine(t.tiers, false)).toBe('The test-out must be at or below 5,561 CFM50 for the 20% tier.');
    expect(summaryText(t, SETTINGS)).toBeNull();
  });
});

describe('the cost cap', () => {
  const program = SETTINGS.programs[0]!;
  const top = program.tiers[2]!;

  it('pays the cap when 75% of the price is below the tier', () => {
    expect(rebateFor(top, program, 2000)).toEqual({ tierAmount: 1800, amount: 1500, cap: 1500, capped: true });
    const e = run({ ...WORKED, cost: '$2,000' });
    expect(headlineWords(e).badge).toBe('40% TIER — $1,500 AIR SEAL REBATE');
    expect(capNote(e)).toBe(' (limited by 75% of $2,000)');
    expect(summaryText(e, SETTINGS)).toContain('Air sealing tier: 40% improvement — rebate $1,500 (limited by 75% of $2,000)');
  });

  it('pays the tier when 75% of the price is above it', () => {
    expect(rebateFor(top, program, 3000)).toEqual({ tierAmount: 1800, amount: 1800, cap: 2250, capped: false });
    expect(capNote(run({ ...WORKED, cost: '3000' }))).toBe('');
  });

  it('pays the tier when the cap equals it', () => {
    expect(rebateFor(top, program, 2400)).toEqual({ tierAmount: 1800, amount: 1800, cap: 1800, capped: false });
  });

  // Release, OD4: whole dollars on every customer surface. A capped rebate is floored to the dollar,
  // so it never shows more than the program pays (was floored to the cent: $925.50, $750.75).
  it('floors a capped amount to whole dollars, never more than the program pays (OD4)', () => {
    expect(rebateFor(top, program, 1234)).toEqual({ tierAmount: 1800, amount: 925, cap: 925, capped: true });
    expect(rebateFor(top, program, 1001)).toMatchObject({ amount: 750, cap: 750 });
    expect(rebateFor(top, program, 1999)).toMatchObject({ amount: 1499, cap: 1499 });
    const e = run({ ...WORKED, cost: '1234' });
    expect(headlineWords(e).badge).toBe('40% TIER — $925 AIR SEAL REBATE');
    expect(summaryText(e, SETTINGS)).toContain('Air sealing tier: 40% improvement — rebate $925 (limited by 75% of $1,234)');
  });

  it('takes the air sealing price in whole dollars, as on the quote (OD4)', () => {
    const cents = run({ ...WORKED, cost: '1999.50' });
    expect(cents.costError).toBe('Air sealing price: whole dollars, as on the quote (no cents).');
    expect(cents.cost).toBeNull();
    expect(cents.rebate!.amount).toBe(1800);
    expect(run({ ...WORKED, cost: '$1,999.00' }).cost).toBe(1999);
    expect(run({ ...WORKED, cost: '$1,999' }).costError).toBeNull();
  });

  it('has nothing to cap below the first tier, or without a cap percent', () => {
    expect(rebateFor(null, program, 1000)).toEqual({ tierAmount: 0, amount: 0, cap: 750, capped: false });
    expect(rebateFor(top, { costCapPct: null }, 1000)).toEqual({ tierAmount: 1800, amount: 1800, cap: null, capped: false });
  });

  it('says what is wrong with a price it cannot use', () => {
    const e = run({ ...WORKED, cost: 'abc' });
    expect(e.costError).toBe('Air sealing price: type a number.');
    expect(e.rebate!.amount).toBe(1800);
  });
});

describe('ventilation', () => {
  it('estimates the BAS from the house: max(0.35 × volume ÷ 60, 15 × occupants) × N × height', () => {
    const b = basFor({ audit: null, volume: 20000, occupants: 3, stories: '2', nFactor: 19 });
    expect(b).toEqual({ source: 'estimated', value: ((0.35 * 20000) / 60) * 19 * 0.81 });
    // Many people in a small house: the people decide.
    const people = basFor({ audit: null, volume: 6000, occupants: 6, stories: '1', nFactor: 19 });
    expect(people.value).toBe(15 * 6 * 19);
    expect(basFor({ audit: null, volume: 12000, occupants: null, stories: '3', nFactor: 18 }).value).toBeCloseTo(70 * 18 * 0.72, 9);
    expect(basFor({ audit: null, volume: 12000, occupants: 0, stories: '1.5', nFactor: 18 }).value).toBeCloseTo(70 * 18 * 0.89, 9);
  });

  it('takes the BAS from the audit over the estimate', () => {
    expect(basFor({ audit: 2000, volume: 20000, occupants: 4, stories: '2', nFactor: 19 })).toEqual({ source: 'audit', value: 2000 });
    const e = run({ ...WORKED, bas: '2000', volume: '20000', occupants: '4' });
    expect(e.bas).toEqual({ source: 'audit', value: 2000 });
    expect(ventilationWords(e.ventilation!, 2000, e.bas, e.program).text).toBe('Ventilation OK: test-out is 1,291 CFM50 above the BAS of 2,000 (from audit).');
  });

  it('needs the volume to estimate (and says so), but not with the audit BAS', () => {
    const noVol = basFor({ audit: null, volume: null, occupants: 3, stories: '2', nFactor: 19 });
    expect(noVol).toEqual({ source: null, value: null, missing: 'volume' });
    expect(basMissingText(noVol)).toBe('Add the house volume to estimate the BAS.');
    expect(basFor({ audit: null, volume: null, occupants: null, stories: '2', nFactor: 19 })).toEqual({ source: null, value: null, missing: 'nothing' });
    expect(basFor({ audit: null, volume: 9000, occupants: null, stories: '2', nFactor: null })).toEqual({ source: null, value: null, missing: 'n-factor' });
    const e = run({ ...WORKED, occupants: '3' });
    expect(e.ventilation).toBeNull();
    expect(e.ach50Pre).toBeNull();
    expect(summaryText(e, SETTINGS)).not.toMatch(/BAS|ACH50/);
    expect(run({ ...WORKED, bas: '1500' }).ventilation!.status).toBe('ok');
  });

  it('draws the line at 70% of the BAS, and at the BAS itself', () => {
    expect(ventilation(1000, 1000)!.status).toBe('ok');
    expect(ventilation(999.9, 1000)!.status).toBe('recommend');
    expect(ventilation(700, 1000)!.status).toBe('recommend');
    expect(ventilation(699.99, 1000)!.status).toBe('install');
    // 70% worked out in decimals: 0.7 × 3,000 is not exact in binary.
    expect(ventilation(2100, 3000)!.status).toBe('recommend');
    expect(ventilation(0, 1000)).toBeNull();
    expect(ventilation(500, 0)).toBeNull();
  });

  it('words each status as the tool always did, with the program’s ventilation rebate', () => {
    const p = SETTINGS.programs[0]!;
    const b = { source: 'estimated', value: 4000 } as const;
    const rec = ventilationWords(ventilation(3291, 4000)!, 4000, b, p);
    expect(rec.tone).toBe('warn');
    expect(rec.text).toBe(
      'Below BAS (82% of 4,000, estimated). BPI: continuous mechanical ventilation must be RECOMMENDED to the customer, sized to make up the 709 CFM50 gap. Program has a mechanical ventilation rebate (up to $400).',
    );
    const ins = ventilationWords(ventilation(2000, 4000)!, 4000, b, SETTINGS.programs[1]!);
    expect(ins.tone).toBe('bad');
    expect(ins.text).toBe(
      'Under 70% of BAS (50% of 4,000, estimated). BPI: continuous mechanical ventilation must be INSTALLED as part of the job, sized for 100% of the ventilation requirement. Program has a mechanical ventilation rebate (up to $600).',
    );
    expect(ins.short).toBe('under 70% of BAS (50%) — mechanical ventilation must be installed');
    // Just under the BAS never reads "100%".
    expect(ventilationWords(ventilation(3998, 4000)!, 4000, b, null).text).toMatch(/^Below BAS \(99% of 4,000, estimated\)\. .* gap\.$/);
  });
});

describe('without a rebate program', () => {
  const e = run(WORKED, NO_PROGRAMS);

  it('still converts and shows the reduction and the ventilation check', () => {
    expect(e.program).toBeNull();
    expect(e.reductionPct).toBeCloseTo(52.66, 2);
    expect(e.tiers).toBeNull();
    expect(headlineWords(e)).toMatchObject({ tone: 'neutral', badge: 'NO REBATE PROGRAM SET UP', big: '52.7%' });
    expect(run({ ...WORKED, bas: '4000' }, NO_PROGRAMS).ventilation!.status).toBe('recommend');
  });

  it('copies a summary that says so', () => {
    const s = summaryText(e, NO_PROGRAMS)!;
    expect(s).toContain('Program: no rebate program set up');
    expect(s).not.toContain('Air sealing tier');
  });

  it('names only the method in the source line', () => {
    expect(sourceLine(null, NO_PROGRAMS)).toBe('Ventilation rules: BPI Building Analyst standard (ASHRAE 62-89). Pressure correction: Retrotec Model 5000 @ Pressure formula.');
  });
});

describe('the source line', () => {
  it('names where the program’s numbers come from', () => {
    expect(sourceLine(SETTINGS.programs[0]!, SETTINGS)).toBe(
      'Tier amounts: Energize Delaware rebate schedule, effective Nov 1, 2024. Paperwork: Participating Contractors Operations Manual (Oct 2025). Ventilation rules: BPI Building Analyst standard (ASHRAE 62-89). Pressure correction: Retrotec Model 5000 @ Pressure formula. Confirm rebate amounts with the program before quoting.',
    );
  });
});

describe('fields the tool cannot use', () => {
  it('starts empty, with the pressures at 50 Pa and the franchise defaults', () => {
    const e = run({});
    expect(e.headline).toEqual({ kind: 'enter' });
    expect(headlineWords(e)).toEqual({ tone: 'neutral', badge: '—', big: '—', unit: null, line: 'Enter both tests below.' });
    // The exponent and N-factor stay empty: the franchise default applies until someone types one (BD-MATH-5).
    expect(emptyForm(SETTINGS)).toMatchObject({ prePa: '50', postPa: '50', exponent: '', nFactor: '', stories: '2' });
    expect(run({}).exponent).toBe(0.65);
    expect(run({}).house.nFactor).toBe(19);
  });

  it('shows an error under a zero or nonsense reading and leaves that test out', () => {
    const e = run({ ...WORKED, preCfm: '0' });
    expect(e.testIn.cfmError).toBe('Fan flow must be more than 0 CFM and at most 50,000 CFM.');
    expect(e.testIn.reading).toBeNull();
    expect(e.headline).toEqual({ kind: 'enter' });
    const p = run({ ...WORKED, postPa: 'x' });
    expect(p.testOut.paError).toBe('House pressure: type a number.');
    expect(p.headline.kind).toBe('test-in-only');
  });

  it('refuses an exponent outside 0.5–1.0 instead of guessing one', () => {
    const e = run({ ...WORKED, exponent: '2' });
    expect(e.exponentError).toBe('Flow exponent must be at least 0.5 and at most 1.');
    expect(e.testIn.reading).toBeNull();
    expect(e.headline).toEqual({ kind: 'enter' });
    expect(run({ ...WORKED, exponent: '' }).exponent).toBe(0.65);
  });

  it('notes a reading far from 50 Pa', () => {
    expect(run({ preCfm: '3000', prePa: '20' }).testIn.lowPressure).toBe(true);
    expect(run({ preCfm: '3000', prePa: '45' }).testIn.lowPressure).toBe(false);
  });

  it('never puts NaN or Infinity in any word on screen', () => {
    const inputs = ['', '0', '-0', 'abc', '1e9', '-1', '0.0001', '99999999', '50', '$', ','];
    for (const a of inputs) {
      for (const b of inputs) {
        const e = run({ preCfm: a, prePa: b, postCfm: b, postPa: a, cost: a, bas: b, volume: a, occupants: b, nFactor: a, exponent: b });
        const words = [JSON.stringify(headlineWords(e)), nextTierLine(e.tiers, !!e.testOut.reading) ?? '', summaryText(e, SETTINGS) ?? ''].join(' ');
        expect(words, `${a} / ${b}`).not.toMatch(/NaN|Infinity/);
      }
    }
  });

  it('reads back a damaged stored form as a usable one', () => {
    expect(reviveForm(null, SETTINGS)).toEqual(emptyForm(SETTINGS));
    expect(reviveForm({ preCfm: 6952, stories: '9', programKey: 'assisted', postPa: '-50' }, SETTINGS)).toMatchObject({ preCfm: '', stories: '2', programKey: 'assisted', postPa: '-50' });
  });
});

describe('saved readings', () => {
  it('are used as recorded, never worked out again with a later exponent', () => {
    const savedIn = { cfm: 3000, pa: 40, exponent: 0.6, cfm50: toCfm50(3000, 40, 0.6)! };
    const e = evaluate({ form: form({ preCfm: '9999', postCfm: '2000', exponent: '0.7' }), settings: SETTINGS, savedIn });
    expect(e.testIn.source).toBe('saved');
    expect(e.testIn.reading).toEqual(savedIn);
    expect(e.testOut.reading!.exponent).toBe(0.7);
    expect(e.reductionPct).toBeCloseTo(((savedIn.cfm50 - 2000) / savedIn.cfm50) * 100, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes (docs/blower-door/build.txt, section 7)
// ---------------------------------------------------------------------------------------------

describe('typing a negative pressure (BD-R8)', () => {
  it('takes a lone sign or dot as not typed yet, not as an error', () => {
    for (const t of ['-', '+', '.', '-.', ' - ']) {
      expect(readNumber(t), t).toBeNull();
      expect(readField(t, RULES.pa), t).toEqual({ state: 'empty' });
    }
    expect(run({ ...WORKED, postPa: '-' }).testOut.paError).toBeNull();
    // Half-typed is still not a reading, and nonsense is still an error.
    expect(run({ ...WORKED, postPa: '-' }).testOut.reading).toBeNull();
    expect(readField('--', RULES.pa)).toEqual({ state: 'invalid', error: 'House pressure: type a number.' });
  });
});

describe('no more decimals than a saved reading keeps (BD-MATH-6)', () => {
  it('refuses a flow exponent with more than 3 decimals', () => {
    expect(readField('0.6525', RULES.exponent)).toEqual({ state: 'invalid', error: 'Flow exponent: at most 3 decimals.' });
    expect(readField('0.653', RULES.exponent)).toEqual({ state: 'ok', value: 0.653 });
    expect(readField('0.6500', RULES.exponent)).toEqual({ state: 'ok', value: 0.65 });
    const e = run({ preCfm: '6000', prePa: '25', postCfm: '4000', postPa: '25', exponent: '0.6525' });
    expect(e.exponentError).toBe('Flow exponent: at most 3 decimals.');
    expect(e.testOut.reading).toBeNull();
  });

  it('reads the other fields at the precision the database keeps', () => {
    expect(readField('4012.3456', RULES.cfm)).toEqual({ state: 'ok', value: 4012.35 });
    expect(readField('-37.777', RULES.pa)).toEqual({ state: 'ok', value: 37.78 });
    expect(readField('17486.25', RULES.volume)).toEqual({ state: 'ok', value: 17486.3 });
    expect(readField('1569.84', RULES.bas)).toEqual({ state: 'ok', value: 1569.8 });
    expect(readField('15.391', RULES.nFactor)).toEqual({ state: 'ok', value: 15.39 });
    // The air sealing price is whole dollars, as on the quote (OD4, release): cents are refused,
    // not read to the cent ($1,999.999 was read as $2,000).
    expect(readField('$1,999.999', RULES.cost)).toEqual({ state: 'invalid', error: 'Air sealing price: whole dollars, as on the quote (no cents).' });
    expect(readField('$2,000', RULES.cost)).toEqual({ state: 'ok', value: 2000 });
  });
});

describe('office defaults reach a phone that already has a form (BD-MATH-5)', () => {
  it('starts the exponent and the N-factor empty, so the office default applies until someone types one', () => {
    expect(emptyForm(SETTINGS)).toMatchObject({ exponent: '', nFactor: '' });
    const kept = reviveForm({ ...emptyForm(SETTINGS), preCfm: '6000', prePa: '25' }, SETTINGS);
    const later: BlowerDoorSettings = { ...SETTINGS, flowExponent: 0.6, nFactor: 17 };
    const e = evaluate({ form: reviveForm(kept, later), settings: later });
    expect(e.exponent).toBe(0.6);
    expect(e.testIn.reading!.cfm50).toBeCloseTo(6000 * 2 ** 0.6, 6);
    expect(e.house.nFactor).toBe(17);
    // A value someone typed is kept.
    expect(evaluate({ form: { ...kept, exponent: '0.7' }, settings: later }).exponent).toBe(0.7);
  });
});

describe('the numbers on screen agree with the decision (BD-MATH-3)', () => {
  it('shows a tier limit as the largest whole CFM50 that reaches it', () => {
    const t = run({ preCfm: '6952' });
    expect(nextTierLine(t.tiers, false)).toBe('The test-out must be at or below 5,561 CFM50 for the 20% tier.');
    expect(shownNumbers(t).limits).toEqual(['5,561', '4,866', '4,171']);
  });

  it('a test-out of 5,562 after 6,952 misses 20% and never reads 20.0%', () => {
    const e = run({ preCfm: '6952', postCfm: '5562' });
    expect(headlineWords(e)).toMatchObject({ badge: 'BELOW 20% — NO AIR SEAL REBATE YET', big: '19.9%', line: '6,952 → 5,562 CFM50' });
    expect(nextTierLine(e.tiers, true)).toBe('Need 1 more CFM50 of reduction to reach the 20% tier.');
    expect(shownNumbers(e)).toMatchObject({ post50: '5,562', limits: ['5,561', '4,866', '4,171'] });
    expect(summaryText(e, SETTINGS)).toContain('Test-out: 5,562 CFM50 (read 5,562 CFM at 50 Pa)\nReduction: 19.9% (1,390 CFM50)\nAir sealing tier: below 20% — no rebate yet');
  });

  it('a test-out that reaches 20% by a fraction never reads the same as one that misses it', () => {
    // 5,576 CFM at 50.2 Pa is 5,561.55 CFM50: under the 5,561.6 limit.
    const e = run({ preCfm: '6952', postCfm: '5576', postPa: '50.2' });
    expect(headlineWords(e)).toMatchObject({ badge: '20% TIER — UP TO $900 AIR SEAL REBATE', big: '20.0%' });
    const s = shownNumbers(e);
    expect(s.post50).toBe('5,561.5');
    expect(s.limits[0]).toBe('5,561.6');
    expect(summaryText(e, SETTINGS)).toContain('Test-out: 5,561.5 CFM50 (read 5,576 CFM at 50.2 Pa)');
  });

  it('a reduction just under a tier shows under it (5,000 then 3,002 is 39.96%)', () => {
    const e = run({ preCfm: '5000', postCfm: '3002' });
    expect(headlineWords(e)).toMatchObject({ badge: '30% TIER — UP TO $1,300 AIR SEAL REBATE', big: '39.9%' });
    expect(summaryText(e, SETTINGS)).toContain('Reduction: 39.9% (1,998 CFM50)');
    // Away from a tier the reduction rounds as it always did.
    expect(headlineWords(run(WORKED)).big).toBe('52.7%');
  });

  it('a test-out just under 70% of the BAS never shows as 70% of it', () => {
    const e = run({ preCfm: '1500', postCfm: '699.6', bas: '1000' });
    expect(e.ventilation!.status).toBe('install');
    expect(shownNumbers(e).post50).toBe('699.6');
    expect(ventilationFor(e)!.text).toMatch(/^Under 70% of BAS \(69% of 1,000, from audit\)\./);
  });

  it('a test-out just under the BAS shows the real gap, never a 0 CFM50 gap', () => {
    const e = run({ preCfm: '1500', postCfm: '999.7', bas: '1000' });
    expect(e.ventilation!.status).toBe('recommend');
    expect(shownNumbers(e)).toMatchObject({ post50: '999.7', bas: '1,000' });
    expect(ventilationFor(e)!.text).toContain('sized to make up the 0.3 CFM50 gap');
  });

  it('with the whole-number setting, decides on CFM50 rounded once, as the gauge and the Test Out Form show it', () => {
    const whole: BlowerDoorSettings = { ...SETTINGS, wholeCfm50: true };
    const c = run({ preCfm: '6952', postCfm: '5576', postPa: '50.2' }, whole);
    expect(c.post50).toBe(5562);
    expect(headlineWords(c)).toMatchObject({ badge: 'BELOW 20% — NO AIR SEAL REBATE YET', big: '19.9%' });
    expect(shownNumbers(c).post50).toBe('5,562');
    const v = run({ preCfm: '1500', postCfm: '699.6', bas: '1000' }, whole);
    expect(v.ventilation!.status).toBe('recommend');
    // The worked example reads the same either way.
    expect(headlineWords(run(WORKED, whole))).toMatchObject({ badge: '40% TIER — UP TO $1,800 AIR SEAL REBATE', big: '52.7%', line: '6,952 → 3,291 CFM50' });
  });
});

describe('ventilation sized in fan CFM as well as CFM50 (BD-MATH-4)', () => {
  // BPI's Albany example: 17,486 ft³, 4 people, 2 stories, N 19 → 102 CFM → BAS 1,570 CFM50.
  const ALBANY = { volume: '17486', occupants: '4', stories: '2' as const, nFactor: '19' };

  it('names the continuous fan flow that closes the gap when it is recommended', () => {
    const e = run({ preCfm: '2500', postCfm: '1500', ...ALBANY });
    expect(cfmText(e.bas.value!)).toBe('1,570');
    expect(e.fanCfm).toBeCloseTo(69.8 / (19 * 0.81), 1);
    const w = ventilationFor(e)!;
    expect(w.text).toBe(
      'Below BAS (95% of 1,570, estimated). BPI: continuous mechanical ventilation must be RECOMMENDED to the customer, sized to make up the 70 CFM50 gap (about 4.5 CFM of continuous fan flow). Program has a mechanical ventilation rebate (up to $400).',
    );
    expect(w.short).toBe('below BAS (95%) — recommend continuous mechanical ventilation (about 4.5 CFM)');
    expect(summaryText(e, SETTINGS)).toContain('BAS: 1,570 CFM50 (estimated) — below BAS (95%) — recommend continuous mechanical ventilation (about 4.5 CFM)');
  });

  it('names the whole requirement when it must be installed', () => {
    const e = run({ preCfm: '2500', postCfm: '1000', ...ALBANY });
    expect(e.fanCfm).toBeCloseTo(102, 0);
    expect(ventilationFor(e)!.text).toContain('sized for 100% of the ventilation requirement (about 102 CFM of continuous fan flow).');
    // From the audit's BAS, the requirement is the BAS back in CFM.
    const a = run({ preCfm: '2500', postCfm: '1000', bas: '1570', stories: '2', nFactor: '19' });
    expect(ventilationFor(a)!.short).toBe('under 70% of BAS (63%) — mechanical ventilation must be installed (about 102 CFM)');
  });

  it('names no fan when ventilation is OK', () => {
    const e = run({ preCfm: '2500', postCfm: '1800', ...ALBANY });
    expect(e.fanCfm).toBeNull();
    expect(ventilationFor(e)!.text).not.toContain('fan flow');
  });
});

describe('the N-factor hint (BD-MATH-7)', () => {
  it('asks for the 1-story zone value, since the tool corrects for the stories itself', () => {
    const h = nFactorHint(19);
    expect(h).toContain("N-factor 19 is BPI's Zone 2 example value (Zone 2 runs 17–20); match it to your audit software.");
    expect(h).toContain('1-story');
    expect(h).toContain('set Stories to 1');
    expect(nFactorHint(17.5)).toMatch(/^N-factor 17\.5 is your office's default; match it to your audit software\. /);
  });
});

describe('release review C DOC-4: a rebate the cost cap was not applied to says so', () => {
  it('with no air sealing price, the badge and the copied summary give the tier amount as the most it pays', () => {
    // The crew's phone: the Assisted program, no price (crews never see one).
    const e = run({ ...WORKED, programKey: 'assisted' });
    expect(headlineWords(e).badge).toBe('40% TIER — UP TO $2,000 AIR SEAL REBATE');
    expect(summaryText(e, SETTINGS)).toContain('Air sealing tier: 40% improvement — rebate up to $2,000 (before the 75% cost cap)');
  });

  it('with the price, the capped amount and its cap note, as before', () => {
    const e = run({ ...WORKED, programKey: 'assisted', cost: '1999' });
    expect(headlineWords(e).badge).toBe('40% TIER — $1,499 AIR SEAL REBATE');
    expect(summaryText(e, SETTINGS)).toContain('Air sealing tier: 40% improvement — rebate $1,499 (limited by 75% of $1,999)');
    // A price the cap does not reach: the tier amount, and no "up to".
    const high = run({ ...WORKED, programKey: 'assisted', cost: '5000' });
    expect(headlineWords(high).badge).toBe('40% TIER — $2,000 AIR SEAL REBATE');
    expect(summaryText(high, SETTINGS)!.split('\n')).toContain('Air sealing tier: 40% improvement — rebate $2,000');
  });

  it('a program with no cost cap pays the tier amount: no "up to"', () => {
    const noCap: BlowerDoorSettings = { ...SETTINGS, programs: SETTINGS.programs.map((p) => ({ ...p, costCapPct: null })) };
    const e = run({ ...WORKED, programKey: 'assisted' }, noCap);
    expect(headlineWords(e).badge).toBe('40% TIER — $2,000 AIR SEAL REBATE');
    expect(summaryText(e, noCap)!.split('\n')).toContain('Air sealing tier: 40% improvement — rebate $2,000');
  });
});
