// What the blower door tool says: the headline, the next-tier line, the ventilation check and the
// plain-text summary people paste into the program's portal. Pure; numbers go through lib/format.
import { formatMoney, num } from '@/lib/format';
import { INSTALL_BELOW, type BasResult, type TierEvaluation, type VentilationStatus } from './calc';
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
  const pre = e.testIn.reading;
  const post = e.testOut.reading;
  const flow = pre && post ? `${cfmText(pre.cfm50)} → ${cfmText(post.cfm50)} CFM50` : '';
  const h = e.headline;
  switch (h.kind) {
    case 'enter':
      return { tone: 'neutral', badge: '—', big: '—', unit: null, line: 'Enter both tests below.' };
    case 'test-in-only':
      return { tone: 'neutral', badge: 'TEST-IN ONLY', big: cfmText(h.pre50), unit: 'CFM50 before', line: 'Enter the test-out after the work.' };
    case 'tier':
      return { tone: 'pass', badge: `${h.tierPct}% TIER — ${money(h.amount)} AIR SEAL REBATE`, big: pctText(h.reductionPct), unit: null, line: flow };
    case 'below':
      return { tone: 'fail', badge: `BELOW ${h.lowestPct}% — NO AIR SEAL REBATE YET`, big: pctText(h.reductionPct), unit: null, line: flow };
    case 'no-program':
      return { tone: 'neutral', badge: 'NO REBATE PROGRAM SET UP', big: pctText(h.reductionPct), unit: null, line: flow };
  }
}

/** Under the tier table: what the next tier needs, or how far past the top tier the house is. */
export function nextTierLine(t: TierEvaluation | null, hasTestOut: boolean): string | null {
  if (!t || t.rows.length === 0) return null;
  if (!hasTestOut) return `The test-out must be at or below ${cfmText(t.rows[0]!.limit)} CFM50 for the ${t.rows[0]!.tier.reductionPct}% tier.`;
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

export function ventilationWords(v: VentilationStatus, bas: number, source: BasResult, program: RebateProgram | null): VentilationWords {
  const src = basSourceText(source);
  if (v.status === 'ok') {
    return {
      tone: 'ok',
      text: `Ventilation OK: test-out is ${cfmText(v.margin)} CFM50 above the BAS of ${cfmText(bas)} (${src}).`,
      short: 'above BAS, no mechanical ventilation needed',
    };
  }
  if (v.status === 'recommend') {
    return {
      tone: 'warn',
      text: `Below BAS (${sharePct(v.ratio)} of ${cfmText(bas)}, ${src}). BPI: continuous mechanical ventilation must be RECOMMENDED to the customer, sized to make up the ${cfmText(v.gap)} CFM50 gap.${mechVentNote(program)}`,
      short: `below BAS (${sharePct(v.ratio)}) — recommend continuous mechanical ventilation`,
    };
  }
  return {
    tone: 'bad',
    text: `Under ${Math.round(INSTALL_BELOW * 100)}% of BAS (${sharePct(v.ratio)} of ${cfmText(bas)}, ${src}). BPI: continuous mechanical ventilation must be INSTALLED as part of the job, sized for 100% of the ventilation requirement.${mechVentNote(program)}`,
    short: `under ${Math.round(INSTALL_BELOW * 100)}% of BAS (${sharePct(v.ratio)}) — mechanical ventilation must be installed`,
  };
}

/** Why the BAS line is empty, when someone has started on it. */
export function basMissingText(b: BasResult): string | null {
  if (b.source !== null) return null;
  if (b.missing === 'volume') return 'Add the house volume to estimate the BAS.';
  if (b.missing === 'n-factor') return 'Add the zone N-factor to estimate the BAS.';
  return null;
}

/** The cap note after a capped rebate: " (limited by 75% of (the price))". */
export function capNote(e: Evaluation): string {
  if (!e.rebate?.capped || !e.program || e.program.costCapPct === null || e.cost === null) return '';
  return ` (limited by ${num(e.program.costCapPct, 2)}% of ${money(e.cost)})`;
}

const readLine = (r: Reading) => `${cfmText(r.cfm50)} CFM50 (read ${cfmText(r.cfm)} CFM at ${paText(r.pa)} Pa)`;

/**
 * The plain-text summary ("Copy summary"), or null until both tests are in. `label` names the
 * house when the tool was opened from a job or an estimate.
 */
export function summaryText(e: Evaluation, settings: Pick<BlowerDoorSettings, 'gauge'>, label: string | null = null): string | null {
  const pre = e.testIn.reading;
  const post = e.testOut.reading;
  if (!pre || !post || e.reductionPct === null || e.removed === null) return null;
  const lines = [`Blower Door Results (${settings.gauge})`];
  if (label) lines.push(`For: ${label}`);
  lines.push(e.program ? `Program: ${e.program.name}` : 'Program: no rebate program set up');
  lines.push(`Test-in: ${readLine(pre)}`, `Test-out: ${readLine(post)}`, `Reduction: ${pctText(e.reductionPct)} (${cfmText(e.removed)} CFM50)`);
  if (e.program && e.tiers && e.rebate) {
    lines.push(
      e.tiers.hit
        ? `Air sealing tier: ${e.tiers.hit.reductionPct}% improvement — rebate ${money(e.rebate.amount)}${capNote(e)}`
        : `Air sealing tier: below ${e.tiers.rows[0]?.tier.reductionPct ?? 0}% — no rebate yet`,
    );
  }
  if (e.bas.value !== null && e.ventilation) {
    lines.push(`BAS: ${cfmText(e.bas.value)} CFM50 (${basSourceText(e.bas)}) — ${ventilationWords(e.ventilation, e.bas.value, e.bas, e.program).short}`);
  }
  if (e.ach50Pre !== null && e.ach50Post !== null) lines.push(`ACH50: ${achText(e.ach50Pre)} -> ${achText(e.ach50Post)}`);
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
