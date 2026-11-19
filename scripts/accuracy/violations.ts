// The permanent accuracy check: prices thousands of random quotes and counts every broken rule.
//
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/violations.ts [count=10000] [seed=20261118] [--rows rows.json]
//   count, seed: how many random quotes (lib/pricing/__fixtures__/random.ts), from which seed.
//   --rows: price with these pricing rows (bundle-rows.sql output) instead of the seeded setup.
// Prints, per rule: the quotes that break it at least once, the breaks, and the breaks by kind;
// then a few examples of each kind. Exit code 0 either way: this measures, it does not gate.
import fs from 'node:fs';
import { priceEstimate, type PricingBundle } from '@/lib/pricing';
import { randomQuotes } from '@/lib/pricing/__fixtures__/random';
import { bundleFromRows, seededBundle } from '@/lib/pricing/__fixtures__/seeded';
import { checkPricedQuote, shownOptions, type Violation } from '@/lib/pricing/invariants';
import { checkQuote, headlineInputFor, linkExpiresAt, PRICE_SURFACES, sampleDraft, sampleQuote, SURFACE_IDS } from '@/lib/quotes/invariants';
import type { SnapshotRows } from '@/lib/server/snapshot';
import { addQuote, newTally, tallyExamples, tallyTable } from './tally';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const rowsPath = flag('--rows');
const count = Number(args[0] ?? 10_000);
const seed = Number(args[1] ?? 20261118);
if (!Number.isInteger(count) || count <= 0 || !Number.isInteger(seed)) throw new Error('Usage: violations.ts [count] [seed] [--rows rows.json]');

const bundle: PricingBundle = rowsPath ? bundleFromRows(JSON.parse(fs.readFileSync(rowsPath, 'utf8')) as SnapshotRows) : seededBundle;
const started = Date.now();
const quotes = randomQuotes(count, seed, bundle);
const tally = newTally();
let options = 0;
let shown = 0;
let noOptions = 0;

for (const q of quotes) {
  let violations: Violation[];
  try {
    // What the customer is shown (OD6), and every option priced (showAll).
    const priced = priceEstimate(q.input, bundle.snapshot, bundle.coefficientSet);
    const all = priceEstimate(q.input, bundle.snapshot, bundle.coefficientSet, { showAll: true });
    options += all.options.length;
    shown += shownOptions(priced).length;
    if (priced.options.length === 0) noOptions++;
    // `all` lets the checks see the options the customer is not shown (were they rightly hidden?).
    violations = checkPricedQuote({ input: q.input, priced, snapshot: bundle.snapshot, coefficients: bundle.coefficientSet, all });
    if (priced.options.length) {
      const draft = sampleDraft({ id: q.id, input: q.input, selectedTier: q.selectedTier, createdAt: q.issuedAt });
      const doc = sampleQuote(draft, { ...priced, options: shownOptions(priced) }, q.issuedAt, q.validDays);
      violations.push(...checkQuote(doc, linkExpiresAt(q.issuedAt, q.validDays), headlineInputFor(draft, priced, bundle)));
    }
  } catch (e) {
    violations = [{ invariant: 'finite_amounts', kind: 'pricing_error', tier: null, areaId: null, detail: e instanceof Error ? e.message : String(e) }];
  }
  addQuote(tally, violations, q.id.slice(0, 8));
}

const lines = [
  `Accuracy check: ${count.toLocaleString('en-US')} random quotes, seed ${seed}, ${rowsPath ? `pricing rows ${rowsPath}` : 'seeded pricing (lib/pricing/__fixtures__/seeded-rows.json)'}, bundle ${bundle.hash}.`,
  `Options priced: ${options.toLocaleString('en-US')}; shown to the customer: ${shown.toLocaleString('en-US')}; quotes with no option: ${noOptions.toLocaleString('en-US')}.`,
  'A quote counts once per rule it breaks; violations count every break (per option, area or surface).',
  '',
  tallyTable(tally),
  '',
  'Price surfaces read (same_price_text kinds):',
  ...SURFACE_IDS.map((id) => `  ${id}: ${PRICE_SURFACES[id].label}, ${PRICE_SURFACES[id].file}:${PRICE_SURFACES[id].line} (${PRICE_SURFACES[id].how})`),
  '',
  'Examples:',
  tallyExamples(tally),
];
console.log(lines.join('\n'));
console.error(`(${((Date.now() - started) / 1000).toFixed(1)} s)`);
