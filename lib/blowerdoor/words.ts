// What the blower door tool says: the headline, the next-tier line, the ventilation check and the
// plain-text summary people paste into the program's portal. Pure; numbers go through lib/format.
import { formatMoney, num } from '@/lib/format';
import { INSTALL_BELOW, ventilation, type BasResult, type TierEvaluation, type VentilationStatus } from './calc';
import type { Evaluation, Reading } from './evaluate';
import { formatEffectiveDate, type BlowerDoorSettings, type RebateProgram } from './settings';

/** Whole numbers with separators: 6,952. */
export const cfmText = (n: number) => num(Math.round(n));
/** A pressure as read: 50, 50.8. */
export const paText = (n: number) => num(n, 2);
/** One decimal: 52.7%. */
export const pctText = (n: number) => `${(Math.round(n * 10) / 10).toFixed(1)}%`;
/** ACH50 with two decimals: 7.10. */
export const achText = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** A share for the ventilation check, rounded down so "below" never reads 100%: 99%. */
const sharePct = (ratio: number) => `${Math.floor(ratio * 100 + 1e-9)}%`;
const money = (n: number) => formatMoney(n);
/** A fan flow: 4.5 under 10 CFM, whole above. */
const fanText = (n: number) => num(n, n < 10 ? 1 : 0);

// ---------------------------------------------------------------------------------------------
// The numbers as shown: they always agree with the decisions
// ---------------------------------------------------------------------------------------------

/** To a tenth, rounded down or up (a hair of floating-point noise is ignored). */
const tenthsDown = (n: number) => Math.floor(n * 10 + 1e-6) / 10;
const tenthsUp = (n: number) => Math.ceil(n * 10 - 1e-6) / 10;
/** A tier's "at or below" limit as the largest whole CFM50 that reaches it: 5,561.6 → 5,561. */
const limitWhole = (limit: number) => Math.floor(limit + 1e-6);

/**
 * The reduction to one decimal, rounded as usual unless that would put it on the other side of a
 * tier line than the decision: 19.994% (missed 20%) reads 19.9%, never 20.0%.
 */
export function reductionText(pct: number, tiers: TierEvaluation | null): string {
  let v = Math.round(pct * 10) / 10;
  if (tiers) {
    if (tiers.rows.some((r) => !r.reached && v >= r.tier.reductionPct)) v = Math.floor(pct * 10) / 10;
    else if (tiers.rows.some((r) => r.reached && v < r.tier.reductionPct)) v = Math.ceil(pct * 10) / 10;
  }
  return `${(v === 0 ? 0 : v).toFixed(1)}%`;
}

export interface ShownNumbers {
  /** The test-in and test-out CFM50s as shown. */
  pre50: string | null;
  post50: string | null;
  /** Each tier's "CFM50 at or below" as shown, in the order of e.tiers.rows. */
  limits: string[];
  bas: string | null;
  /** BAS − test-out (below the BAS) or test-out − BAS (above it), from the numbers shown. */
  gap: string | null;
  margin: string | null;
  reduction: string | null;
  removed: string | null;
}

/**
 * The CFM50s, tier limits, BAS and reduction as the screen, the summary and the office page show
 * them. Whole numbers as a rule; a limit is the largest whole CFM50 that reaches it. When whole
 * numbers would contradict a decision (a test-out of 5,561.55 reaches a 5,561.6 limit but rounds to
 * 5,562; 699.6 is under 70% of a BAS of 1,000 but rounds to 700), the test-out and that line are
 * shown to a tenth, rounded toward the side the decision put them on. With the franchise's
 * whole-number setting the decisions use whole CFM50s, so whole numbers always agree.
 */
export function shownNumbers(e: Evaluation): ShownNumbers {
  const post = e.post50;
  const rows = e.tiers?.rows ?? [];
  let postV = post === null ? null : Math.round(post);
  let postTenths = false;
  const limitV = rows.map((r) => limitWhole(r.limit));
  const limitTenths = rows.map(() => false);
  if (post !== null) {
    rows.forEach((r, i) => {
      if (postV! <= limitV[i]! === r.reached) return;
      if (!postTenths) {
        postV = r.reached ? tenthsDown(post) : tenthsUp(post);
        postTenths = true;
      }
      limitV[i] = tenthsDown(r.limit);
      limitTenths[i] = true;
    });
    // A test-out now shown to a tenth is checked against the other limits once more.
    rows.forEach((r, i) => {
      if (postV! <= limitV[i]! !== r.reached) {
        limitV[i] = tenthsDown(r.limit);
        limitTenths[i] = true;
      }
    });
  }

  let basV = e.bas.value === null ? null : Math.round(e.bas.value);
  let basTenths = false;
  const v = e.ventilation;
  if (post !== null && postV !== null && basV !== null && e.bas.value !== null && v && ventilation(postV, basV)?.status !== v.status) {
    // Above the BAS (or just at 70% of it): round the test-out up and the BAS down; below: the other way.
    const upward = v.status === 'ok' || (v.status === 'recommend' && postV < INSTALL_BELOW * basV);
    if (!postTenths) {
      postV = upward ? tenthsUp(post) : tenthsDown(post);
      postTenths = true;
    }
    basV = upward ? tenthsDown(e.bas.value) : tenthsUp(e.bas.value);
    basTenths = true;
  }

  const show = (n: number, tenths: boolean) => num(n, tenths ? 1 : 0);
  const diff = (a: number, b: number) => show(Math.round((a - b) * 10) / 10, postTenths || basTenths);
  return {
    pre50: e.pre50 === null ? null : cfmText(e.pre50),
    post50: postV === null ? null : show(postV, postTenths),
    limits: limitV.map((n, i) => show(n, limitTenths[i]!)),
    bas: basV === null ? null : show(basV, basTenths),
    gap: postV !== null && basV !== null ? diff(basV, postV) : null,
    margin: postV !== null && basV !== null ? diff(postV, basV) : null,
    reduction: e.reductionPct === null ? null : reductionText(e.reductionPct, e.tiers),
    removed: e.removed === null ? null : cfmText(e.removed),
  };
}

export interface HeadlineWords {
  tone: 'pass' | 'fail' | 'neutral';
  /** The wide caps line: "40% TIER — (amount) AIR SEAL REBATE". */
  badge: string;
  /** The big gauge: "52.7%" or "6,952". */
  big: string;
  /** The unit under the gauge, when it is not a percent. */
  unit: string | null;
  line: string;
}

export function headlineWords(e: Evaluation): HeadlineWords {
  const s = shownNumbers(e);
  const flow = s.pre50 !== null && s.post50 !== null ? `${s.pre50} → ${s.post50} CFM50` : '';
  const big = s.reduction ?? '—';
  const h = e.headline;
  switch (h.kind) {
    case 'enter':
      return { tone: 'neutral', badge: '—', big: '—', unit: null, line: 'Enter both tests below.' };
    case 'test-in-only':
      return { tone: 'neutral', badge: 'TEST-IN ONLY', big: cfmText(h.pre50), unit: 'CFM50 before', line: 'Enter the test-out after the work.' };
    case 'tier':
      return { tone: 'pass', badge: `${h.tierPct}% TIER — ${money(h.amount)} AIR SEAL REBATE`, big, unit: null, line: flow };
    case 'below':
      return { tone: 'fail', badge: `BELOW ${h.lowestPct}% — NO AIR SEAL REBATE YET`, big, unit: null, line: flow };
    case 'no-program':
      return { tone: 'neutral', badge: 'NO REBATE PROGRAM SET UP', big, unit: null, line: flow };
  }
}

/** Under the tier table: what the next tier needs, or how far past the top tier the house is. */
export function nextTierLine(t: TierEvaluation | null, hasTestOut: boolean): string | null {
  if (!t || t.rows.length === 0) return null;
  if (!hasTestOut) return `The test-out must be at or below ${num(limitWhole(t.rows[0]!.limit))} CFM50 for the ${t.rows[0]!.tier.reductionPct}% tier.`;
  if (t.next) return `Need ${num(t.next.need)} more CFM50 of reduction to reach the ${t.next.tier.reductionPct}% tier.`;
  if (t.spare !== null) return `Top tier reached with ${num(t.spare)} CFM50 to spare.`;
  return null;
}

/** "from audit" or "estimated". */
export const basSourceText = (b: BasResult) => (b.source === 'audit' ? 'from audit' : 'estimated');

const mechVentNote = (p: RebateProgram | null) =>
  p && p.mechVentRebateCap !== null && p.mechVentRebateCap > 0 ? ` Program has a mechanical ventilation rebate (up to ${money(p.mechVentRebateCap)}).` : '';

export interface VentilationWords {
  tone: 'ok' | 'warn' | 'bad';
  text: string;
  /** For the summary. */
  short: string;
}

/** The numbers the ventilation words use, as shown (shownNumbers), and the fan flow. */
export interface VentilationNumbers {
  bas?: string;
  gap?: string;
  margin?: string;
  /** Continuous fan flow in CFM (Evaluation.fanCfm). */
  fanCfm?: number | null;
}

export function ventilationWords(v: VentilationStatus, bas: number, source: BasResult, program: RebateProgram | null, n: VentilationNumbers = {}): VentilationWords {
  const src = basSourceText(source);
  const basS = n.bas ?? cfmText(bas);
  const fan = n.fanCfm != null && n.fanCfm > 0 ? fanText(n.fanCfm) : null;
  if (v.status === 'ok') {
    return {
      tone: 'ok',
      text: `Ventilation OK: test-out is ${n.margin ?? cfmText(v.margin)} CFM50 above the BAS of ${basS} (${src}).`,
      short: 'above BAS, no mechanical ventilation needed',
    };
  }
  if (v.status === 'recommend') {
    return {
      tone: 'warn',
      text: `Below BAS (${sharePct(v.ratio)} of ${basS}, ${src}). BPI: continuous mechanical ventilation must be RECOMMENDED to the customer, sized to make up the ${n.gap ?? cfmText(v.gap)} CFM50 gap${fan ? ` (about ${fan} CFM of continuous fan flow)` : ''}.${mechVentNote(program)}`,
      short: `below BAS (${sharePct(v.ratio)}) — recommend continuous mechanical ventilation${fan ? ` (about ${fan} CFM)` : ''}`,
    };
  }
  return {
    tone: 'bad',
    text: `Under ${Math.round(INSTALL_BELOW * 100)}% of BAS (${sharePct(v.ratio)} of ${basS}, ${src}). BPI: continuous mechanical ventilation must be INSTALLED as part of the job, sized for 100% of the ventilation requirement${fan ? ` (about ${fan} CFM of continuous fan flow)` : ''}.${mechVentNote(program)}`,
    short: `under ${Math.round(INSTALL_BELOW * 100)}% of BAS (${sharePct(v.ratio)}) — mechanical ventilation must be installed${fan ? ` (about ${fan} CFM)` : ''}`,
  };
}

/** The ventilation words for an evaluation, with the numbers as shown and the fan flow; null without a check. */
export function ventilationFor(e: Evaluation): VentilationWords | null {
  if (!e.ventilation || e.bas.value === null) return null;
  const s = shownNumbers(e);
  return ventilationWords(e.ventilation, e.bas.value, e.bas, e.program, { bas: s.bas ?? undefined, gap: s.gap ?? undefined, margin: s.margin ?? undefined, fanCfm: e.fanCfm });
}

/** Why the BAS line is empty, when someone has started on it. */
export function basMissingText(b: BasResult): string | null {
  if (b.source !== null) return null;
  if (b.missing === 'volume') return 'Add the house volume to estimate the BAS.';
  if (b.missing === 'n-factor') return 'Add the zone N-factor to estimate the BAS.';
  return null;
}

/**
 * The hint under the N-factor field. BPI multiplies the zone's 1-story N-factor by the height
 * correction for the stories, so an N that audit software already corrected for the stories must
 * not be corrected again.
 */
export function nFactorHint(nFactor: number): string {
  const first =
    nFactor === 19
      ? "N-factor 19 is BPI's Zone 2 example value (Zone 2 runs 17–20); match it to your audit software."
      : `N-factor ${num(nFactor, 2)} is your office's default; match it to your audit software.`;
  return `${first} Enter the zone's 1-story value: the tool applies the stories correction itself. If your software's N already allows for the number of stories, set Stories to 1.`;
}

/** The cap note after a capped rebate: " (limited by 75% of (the price))". */
export function capNote(e: Evaluation): string {
  if (!e.rebate?.capped || !e.program || e.program.costCapPct === null || e.cost === null) return '';
  return ` (limited by ${num(e.program.costCapPct, 2)}% of ${money(e.cost)})`;
}

const readLine = (shown: string, r: Reading) => `${shown} CFM50 (read ${cfmText(r.cfm)} CFM at ${paText(r.pa)} Pa)`;

/**
 * The plain-text summary ("Copy summary"), or null until both tests are in. `label` names the
 * house when the tool was opened from a job or an estimate; `notes` are added at the end (a
 * reading that has not reached the office yet).
 */
export function summaryText(e: Evaluation, settings: Pick<BlowerDoorSettings, 'gauge'>, label: string | null = null, notes: readonly string[] = []): string | null {
  const pre = e.testIn.reading;
  const post = e.testOut.reading;
  if (!pre || !post || e.reductionPct === null || e.removed === null) return null;
  const s = shownNumbers(e);
  const lines = [`Blower Door Results (${settings.gauge})`];
  if (label) lines.push(`For: ${label}`);
  lines.push(e.program ? `Program: ${e.program.name}` : 'Program: no rebate program set up');
  lines.push(`Test-in: ${readLine(s.pre50!, pre)}`, `Test-out: ${readLine(s.post50!, post)}`, `Reduction: ${s.reduction} (${s.removed} CFM50)`);
  if (e.program && e.tiers && e.rebate) {
    lines.push(
      e.tiers.hit
        ? `Air sealing tier: ${e.tiers.hit.reductionPct}% improvement — rebate ${money(e.rebate.amount)}${capNote(e)}`
        : `Air sealing tier: below ${e.tiers.rows[0]?.tier.reductionPct ?? 0}% — no rebate yet`,
    );
  }
  const vent = ventilationFor(e);
  if (e.bas.value !== null && vent) lines.push(`BAS: ${s.bas} CFM50 (${basSourceText(e.bas)}) — ${vent.short}`);
  if (e.ach50Pre !== null && e.ach50Post !== null) lines.push(`ACH50: ${achText(e.ach50Pre)} -> ${achText(e.ach50Post)}`);
  lines.push(...notes);
  return lines.join('\n');
}

/**
 * The source line under the paperwork list: where the program's numbers and rules come from.
 * The ventilation and pressure rules are the method, the same for every franchise.
 */
export function sourceLine(program: RebateProgram | null, settings: Pick<BlowerDoorSettings, 'gauge'>): string {
  const parts: string[] = [];
  if (program) {
    const eff = formatEffectiveDate(program.effectiveDate);
    if (program.source) parts.push(`Tier amounts: ${program.source}${eff ? `, effective ${eff}` : ''}.`);
    else if (eff) parts.push(`Tier amounts effective ${eff}.`);
    if (program.paperwork.length && program.paperworkSource) parts.push(`Paperwork: ${program.paperworkSource}.`);
  }
  parts.push('Ventilation rules: BPI Building Analyst standard (ASHRAE 62-89).', `Pressure correction: ${settings.gauge} @ Pressure formula.`);
  if (program) parts.push('Confirm rebate amounts with the program before quoting.');
  return parts.join(' ');
}
