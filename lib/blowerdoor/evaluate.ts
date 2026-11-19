// Everything the blower door tool shows, worked out from what was typed (and any readings already
// saved to the job), the franchise's settings and the chosen program. Pure: the screen, the copied
// summary and the office job page all read the same result.
import { ach50, basFor, DEFAULT_STORIES, evaluateTiers, isStories, rebateFor, reductionPct, toCfm50, ventilation, type BasResult, type Rebate, type Stories, type TierEvaluation, type VentilationStatus } from './calc';
import { errorOf, LOW_PRESSURE_PA, readField, RULES, valueOf, type FieldValue } from './numbers';
import type { BlowerDoorSettings, RebateProgram } from './settings';

/** What the phone keeps for one job, estimate or the scratch calculator, as typed. */
export interface BlowerDoorForm {
  /** The chosen program; null picks the first one. */
  programKey: string | null;
  preCfm: string;
  prePa: string;
  postCfm: string;
  postPa: string;
  /** Installed air sealing price, for the cost cap. */
  cost: string;
  /** BAS from the audit, in CFM50. */
  bas: string;
  volume: string;
  occupants: string;
  stories: Stories;
  nFactor: string;
  exponent: string;
}

/** A fresh form: the pressures at 50 Pa and the franchise's defaults filled in. */
export function emptyForm(settings: Pick<BlowerDoorSettings, 'flowExponent' | 'nFactor'>, programKey: string | null = null): BlowerDoorForm {
  return {
    programKey,
    preCfm: '',
    prePa: '50',
    postCfm: '',
    postPa: '50',
    cost: '',
    bas: '',
    volume: '',
    occupants: '',
    stories: DEFAULT_STORIES,
    nFactor: String(settings.nFactor),
    exponent: String(settings.flowExponent),
  };
}

/** A stored form read back leniently (an older or damaged copy becomes a usable one). */
export function reviveForm(v: unknown, settings: Pick<BlowerDoorSettings, 'flowExponent' | 'nFactor'>): BlowerDoorForm {
  const base = emptyForm(settings);
  if (v === null || typeof v !== 'object') return base;
  const o = v as Record<string, unknown>;
  const str = (k: keyof BlowerDoorForm) => (typeof o[k] === 'string' ? (o[k] as string).slice(0, 40) : (base[k] as string));
  return {
    programKey: typeof o.programKey === 'string' ? o.programKey : null,
    preCfm: str('preCfm'),
    prePa: str('prePa'),
    postCfm: str('postCfm'),
    postPa: str('postPa'),
    cost: str('cost'),
    bas: str('bas'),
    volume: str('volume'),
    occupants: str('occupants'),
    stories: isStories(o.stories) ? o.stories : base.stories,
    nFactor: str('nFactor'),
    exponent: str('exponent'),
  };
}

/** One test, converted to 50 Pa. */
export interface Reading {
  cfm: number;
  pa: number;
  exponent: number;
  cfm50: number;
}

export type ReadingSource = 'typed' | 'saved';

export interface TestResult {
  reading: Reading | null;
  source: ReadingSource;
  /** Far from 50 Pa: the CFM50 is extrapolated a long way. */
  lowPressure: boolean;
  cfmError: string | null;
  paError: string | null;
}

export type Headline =
  | { kind: 'enter' }
  | { kind: 'test-in-only'; pre50: number }
  | { kind: 'tier'; reductionPct: number; tierPct: number; amount: number; capped: boolean }
  | { kind: 'below'; reductionPct: number; lowestPct: number }
  | { kind: 'no-program'; reductionPct: number };

export interface Evaluation {
  program: RebateProgram | null;
  /** The flow exponent used for typed readings, or null with an error. */
  exponent: number | null;
  exponentError: string | null;
  testIn: TestResult;
  testOut: TestResult;
  /** Reduction in CFM50, percent (both tests needed). */
  reductionPct: number | null;
  /** CFM50 taken out. */
  removed: number | null;
  /** Reduction from the raw gauge readings, before the pressure correction. */
  rawReductionPct: number | null;
  /** The program's tiers against the test-in (limits) and the test-out (reached). */
  tiers: TierEvaluation | null;
  rebate: Rebate | null;
  costError: string | null;
  cost: number | null;
  bas: BasResult;
  basErrors: { bas: string | null; volume: string | null; occupants: string | null; nFactor: string | null };
  ventilation: VentilationStatus | null;
  volume: number | null;
  ach50Pre: number | null;
  ach50Post: number | null;
  headline: Headline;
}

/** The program a form uses: the chosen one if it still exists, else the first. */
export function chosenProgram(settings: BlowerDoorSettings, key: string | null): RebateProgram | null {
  return settings.programs.find((p) => p.key === key) ?? settings.programs[0] ?? null;
}

function typedTest(cfmText: string, paText: string, exponent: number | null): TestResult {
  const cfm = readField(cfmText, RULES.cfm);
  const pa = readField(paText, RULES.pa);
  const c = valueOf(cfm);
  const p = valueOf(pa);
  const cfm50 = c !== null && p !== null && exponent !== null ? toCfm50(c, p, exponent) : null;
  return {
    reading: cfm50 !== null ? { cfm: c!, pa: p!, exponent: exponent!, cfm50 } : null,
    source: 'typed',
    lowPressure: p !== null && p < LOW_PRESSURE_PA,
    cfmError: errorOf(cfm),
    paError: errorOf(pa),
  };
}

function savedTest(r: Reading): TestResult {
  return { reading: r, source: 'saved', lowPressure: r.pa < LOW_PRESSURE_PA, cfmError: null, paError: null };
}

export interface EvaluateInput {
  form: BlowerDoorForm;
  settings: BlowerDoorSettings;
  /**
   * Readings saved to the job, shown as recorded instead of the typed fields: their CFM50 is the
   * one worked out when they were taken, never again with a later exponent.
   */
  savedIn?: Reading | null;
  savedOut?: Reading | null;
}

export function evaluate({ form, settings, savedIn = null, savedOut = null }: EvaluateInput): Evaluation {
  const program = chosenProgram(settings, form.programKey);

  const exp = form.exponent.trim() === '' ? ({ state: 'ok', value: settings.flowExponent } as FieldValue) : readField(form.exponent, RULES.exponent);
  const exponent = valueOf(exp);

  const testIn = savedIn ? savedTest(savedIn) : typedTest(form.preCfm, form.prePa, exponent);
  const testOut = savedOut ? savedTest(savedOut) : typedTest(form.postCfm, form.postPa, exponent);
  const pre = testIn.reading;
  const post = testOut.reading;

  const reduction = pre && post ? reductionPct(pre.cfm50, post.cfm50) : null;
  const rawReduction = pre && post ? reductionPct(pre.cfm, post.cfm) : null;
  const tiers = pre && program ? evaluateTiers(pre.cfm50, post?.cfm50 ?? null, program.tiers) : null;

  const costField = readField(form.cost, RULES.cost);
  const cost = valueOf(costField);
  const rebate = program && tiers && post ? rebateFor(tiers.hit, program, cost) : null;

  const basField = readField(form.bas, RULES.bas);
  const volField = readField(form.volume, RULES.volume);
  const occField = readField(form.occupants, RULES.occupants);
  const nfField = form.nFactor.trim() === '' ? ({ state: 'ok', value: settings.nFactor } as FieldValue) : readField(form.nFactor, RULES.nFactor);
  const volume = valueOf(volField);
  const bas = basFor({ audit: valueOf(basField), volume, occupants: valueOf(occField), stories: form.stories, nFactor: valueOf(nfField) });
  const vent = post && bas.value !== null ? ventilation(post.cfm50, bas.value) : null;

  let headline: Headline = { kind: 'enter' };
  if (pre && !post) headline = { kind: 'test-in-only', pre50: pre.cfm50 };
  else if (pre && post && reduction !== null) {
    if (!program || !tiers) headline = { kind: 'no-program', reductionPct: reduction };
    else if (tiers.hit && rebate) headline = { kind: 'tier', reductionPct: reduction, tierPct: tiers.hit.reductionPct, amount: rebate.amount, capped: rebate.capped };
    else headline = { kind: 'below', reductionPct: reduction, lowestPct: tiers.rows[0]?.tier.reductionPct ?? 0 };
  }

  return {
    program,
    exponent,
    exponentError: errorOf(exp),
    testIn,
    testOut,
    reductionPct: reduction,
    removed: pre && post ? pre.cfm50 - post.cfm50 : null,
    rawReductionPct: rawReduction,
    tiers,
    rebate,
    costError: errorOf(costField),
    cost,
    bas,
    basErrors: { bas: errorOf(basField), volume: errorOf(volField), occupants: errorOf(occField), nFactor: errorOf(nfField) },
    ventilation: vent,
    volume,
    ach50Pre: pre ? ach50(pre.cfm50, volume) : null,
    ach50Post: post ? ach50(post.cfm50, volume) : null,
    headline,
  };
}
