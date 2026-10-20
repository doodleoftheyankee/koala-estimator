// Estimator line overrides (PLAN.md §6.5): the estimator's own quantity (material lines) or
// person-hours (labor/removal lines) for one area line. Overrides are keyed by lineKey() and carry
// the option they were made on; every other option with the same area + product + kind moves by
// the same proportion (see LineOverride). Pure helpers behind the Options step; drafts are never
// mutated.
import type { LineOverride, PricedLine, PricedOption, ProductUnit, Tier } from '@/lib/pricing';
import { lineOverrideSchema, type EstimateDraft } from '@/lib/sync/draft';

export type LineMetric = 'qty' | 'hours';

/** What the Options step shows for one editable line: model vs the estimator's value. */
export interface LineView {
  key: string;
  metric: LineMetric;
  /** Material unit for qty lines; 'hour' for labor/removal lines. */
  unit: ProductUnit | null;
  modelValue: number;
  /** What will be quoted: the override when set, else the model value. */
  value: number;
  /** (value - model) / model; null when the model value is 0 (no meaningful percentage). */
  pctDiff: number | null;
  isOverridden: boolean;
  reason: string | null;
}

/** 'qty' for material lines, 'hours' for labor/removal lines, null for lines nobody edits (drive, disposal). */
export function lineMetric(line: Pick<PricedLine, 'key' | 'kind'>): LineMetric | null {
  if (!line.key) return null;
  if (line.kind === 'material') return 'qty';
  if (line.kind === 'labor' || line.kind === 'removal') return 'hours';
  return null;
}

/** The editable view of a line, or null when the line cannot be overridden. */
export function lineView(line: PricedLine): LineView | null {
  const metric = lineMetric(line);
  if (!metric || !line.key) return null;
  const model = metric === 'qty' ? line.modelQty : line.modelHours;
  const value = metric === 'qty' ? line.qty : line.hours;
  if (!isNum(model) || !isNum(value)) return null;
  return {
    key: line.key,
    metric,
    unit: metric === 'qty' ? line.unit : 'hour',
    modelValue: model,
    value,
    pctDiff: relativeDiff(value, model),
    isOverridden: line.isOverridden,
    reason: line.isOverridden ? line.overrideReason : null,
  };
}

/** (value - model) / model, or null when either is not a finite number or the model is <= 0. */
export function relativeDiff(value: number, model: number): number | null {
  if (!isNum(value) || !isNum(model) || model <= 0) return null;
  return (value - model) / model;
}

export type BuiltOverride = { ok: true; override: LineOverride } | { ok: false; error: string };

/**
 * Validates what the estimator typed with the same schema the sync uses, so an override that
 * passes here can never make the draft unsyncable.
 */
export function buildLineOverride(metric: LineMetric, value: number | null, reason: string, tier?: Tier): BuiltOverride {
  if (value === null || !Number.isFinite(value)) {
    return { ok: false, error: metric === 'qty' ? 'Enter a quantity.' : 'Enter the person-hours.' };
  }
  if (value < 0) return { ok: false, error: 'The number cannot be negative.' };
  const candidate: LineOverride = metric === 'qty' ? { qty: value, reason: reason.trim() } : { hours: value, reason: reason.trim() };
  if (tier) candidate.tier = tier;
  const parsed = lineOverrideSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, override: candidate };
  const issue = parsed.error.issues[0];
  if (issue?.path[0] === 'reason') {
    return { ok: false, error: candidate.reason.length < 3 ? 'Give a reason (at least 3 characters).' : 'Keep the reason under 500 characters.' };
  }
  return { ok: false, error: 'That number is too large.' };
}

/** Sets the override for one line key (every option with that line picks it up, scaled). */
export function applyLineOverride(draft: EstimateDraft, key: string, override: LineOverride): EstimateDraft {
  return { ...draft, lineOverrides: { ...draft.lineOverrides, [key]: override } };
}

/** Back to the model value for this line key. */
export function removeLineOverride(draft: EstimateDraft, key: string): EstimateDraft {
  // Drafts saved on a phone before Phase 2 are not re-parsed and may have no lineOverrides at all.
  const current = draft.lineOverrides as EstimateDraft['lineOverrides'] | undefined;
  if (!current || !Object.hasOwn(current, key)) return draft;
  const lineOverrides = { ...current };
  delete lineOverrides[key];
  return { ...draft, lineOverrides };
}

/** Tiers whose option contains a line with this key, in option order. */
export function tiersWithLine(options: ReadonlyArray<Pick<PricedOption, 'tier' | 'lines'>>, key: string): Tier[] {
  return options.filter((o) => o.lines.some((l) => l.key === key)).map((o) => o.tier);
}

const UNITS: Record<ProductUnit, [one: string, many: string]> = {
  board_ft: ['board ft', 'board ft'],
  bag: ['bag', 'bags'],
  sqft: ['sq ft', 'sq ft'],
  linear_ft: ['linear ft', 'linear ft'],
  hour: ['h', 'h'],
  each: ['unit', 'units'],
};

/** Plural unit label for form fields ("bags", "board ft", "h"). */
export function unitLabel(unit: ProductUnit | null): string {
  return unit ? UNITS[unit][1] : 'units';
}

/** "58 bags", "1 bag", "1,200 board ft", "10.5 h". */
export function formatAmount(n: number, unit: ProductUnit | null): string {
  const text = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (!unit) return text;
  const [one, many] = UNITS[unit];
  return `${text} ${n === 1 ? one : many}`;
}

/** Signed percentage: "+20.7%", "−13%", "0%"; one decimal below 20% (like the deviation messages). */
export function formatPctDiff(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '—';
  const v = Math.abs(p) * 100;
  const text = v >= 20 ? Math.round(v).toLocaleString('en-US') : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  if (text === '0') return '0%';
  return `${p > 0 ? '+' : '−'}${text}%`;
}

function isNum(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}
