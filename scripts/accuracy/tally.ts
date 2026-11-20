// Counting violations the same way for the random run and the golden sets.
import { INVARIANT_IDS, type InvariantId, type Violation } from '@/lib/pricing/invariants';

export interface Tally {
  /** Quotes (or estimates) checked. */
  checked: number;
  /** Per rule: how many quotes break it at least once, how many breaks, and the breaks by kind. */
  rules: Record<InvariantId, { quotes: number; violations: number; byKind: Record<string, number>; examples: string[] }>;
}

export function newTally(): Tally {
  return {
    checked: 0,
    rules: Object.fromEntries(
      INVARIANT_IDS.map((id) => [id, { quotes: 0, violations: 0, byKind: {} as Record<string, number>, examples: [] as string[] }]),
    ) as Tally['rules'],
  };
}

/** Adds one quote's violations. `label` names the quote in the examples. */
export function addQuote(t: Tally, violations: Violation[], label: string, examplesPerKind = 2): void {
  t.checked++;
  const hit = new Set<InvariantId>();
  for (const v of violations) {
    const rule = t.rules[v.invariant];
    rule.violations++;
    rule.byKind[v.kind] = (rule.byKind[v.kind] ?? 0) + 1;
    hit.add(v.invariant);
    const sameKind = rule.examples.filter((e) => e.startsWith(`[${v.kind}]`)).length;
    if (sameKind < examplesPerKind) rule.examples.push(`[${v.kind}] ${label}${v.tier ? ` ${v.tier}` : ''}: ${v.detail}`);
  }
  for (const id of hit) t.rules[id].quotes++;
}

const n = (x: number) => x.toLocaleString('en-US');
const pct = (a: number, b: number) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '0%');

/** The table: one row per rule (quotes with a break, breaks, breaks by kind). */
export function tallyTable(t: Tally, what = 'Quotes'): string {
  const rows = INVARIANT_IDS.map((id) => {
    const r = t.rules[id];
    const kinds = Object.entries(r.byKind)
      .sort(([, a], [, b]) => b - a)
      .map(([k, c]) => `${k} ${n(c)}`)
      .join(', ');
    return `| ${id} | ${n(r.quotes)} (${pct(r.quotes, t.checked)}) | ${n(r.violations)} | ${kinds} |`;
  });
  return [`| Invariant | ${what} | Violations | By kind |`, '|---|---|---|---|', ...rows].join('\n');
}

export function tallyExamples(t: Tally): string {
  return INVARIANT_IDS.filter((id) => t.rules[id].examples.length)
    .map((id) => [`${id}:`, ...t.rules[id].examples.map((e) => `  ${e}`)].join('\n'))
    .join('\n');
}
