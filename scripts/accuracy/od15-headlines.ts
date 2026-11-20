// OD15 (review B flow-B4): which random quotes' headlines move from the recommended-option rule
// before it (oldRecommended, the rule of lib/field/recommended.ts at 001050c) to the rule now.
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/od15-headlines.ts [count=10000] [seed=20261118]
// The counts are in docs/accuracy/after-fixb/headline-changes.txt.
import { priceEstimate } from '@/lib/pricing';
import { randomQuotes } from '@/lib/pricing/__fixtures__/random';
import { seededBundle as bundle } from '@/lib/pricing/__fixtures__/seeded';
import { recommendedTier } from '@/lib/field/recommended';
const ORDER = ['good', 'better', 'best'];
const rank = (t: string) => (ORDER.indexOf(t) < 0 ? 3 : ORDER.indexOf(t));
function oldRecommended(options: { tier: string }[], sel: string | null) {
  const p = options.find((o) => o.tier === sel);
  if (p) return p.tier;
  if (sel && ORDER.includes(sel)) {
    const at = rank(sel);
    const by = [...options].sort((a, b) => rank(a.tier) - rank(b.tier));
    const n = by.find((o) => rank(o.tier) > at) ?? by.filter((o) => rank(o.tier) < at).pop();
    if (n) return n.tier;
  }
  return (options.find((o) => o.tier === 'better') ?? options[0])?.tier;
}
const count = Number(process.argv[2] ?? 10_000);
const seed = Number(process.argv[3] ?? 20261118);
const c: Record<string, number> = {};
const ex: string[] = [];
let quotes = 0;
for (const q of randomQuotes(count, seed, bundle)) {
  try {
    const shown = priceEstimate(q.input, bundle.snapshot, bundle.coefficientSet).options;
    if (!shown.length) continue;
    quotes++;
    const before = oldRecommended(shown, q.selectedTier);
    const after = recommendedTier(shown, q.selectedTier)!.tier;
    if (before === after) continue;
    const pb = shown.find((o) => o.tier === before)!.price;
    const pa = shown.find((o) => o.tier === after)!.price;
    const k = `pick=${q.selectedTier ?? 'none'} shown=${shown.map((o) => o.tier).join('+')} ${before}->${after}`;
    c[k] = (c[k] ?? 0) + 1;
    if (ex.length < 3) ex.push(`${q.id.slice(0, 8)} ${k} $${pb} -> $${pa}`);
  } catch {
    // A pricing error is counted by violations.ts; it has no headline.
  }
}
console.log(`seed ${seed} (${count}, ${quotes} with an option):`, JSON.stringify(c), '\n  ' + ex.join('\n  '));
