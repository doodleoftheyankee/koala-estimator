// Prices a golden set as the app would quote it today and checks every rule on each estimate.
//
// Usage:
//   node scripts/accuracy/run.mjs scripts/accuracy/price-golden.ts synthetic <out.json>
//     The synthetic set (scripts/accuracy/golden-synthetic.json), priced with the seeded setup.
//     Writes every estimate in full: option totals, items, titles, bullets, headline, violations.
//   node scripts/accuracy/run.mjs scripts/accuracy/price-golden.ts live <golden dir> <out.json> [<summary.json>] [--with-accuracy-rows]
//     The live set made by make-live-golden.ts, priced with the live pricing rows. <out.json> (keep it
//     out of git) has every estimate in full; <summary.json> has only counts and each estimate's option
//     totals keyed by estimate id (no names or addresses), fit to commit.
// Both print the number of estimates breaking each rule.
import fs from 'node:fs';
import path from 'node:path';
import type { PricingBundle, Tier } from '@/lib/pricing';
import { withAccuracyRows } from '@/lib/accuracy/rows';
import { bundleFromRows, seededBundle, seededRows } from '@/lib/pricing/__fixtures__/seeded';
import type { SnapshotRows } from '@/lib/server/snapshot';
import { liveGolden, priceGolden, storedValidUntil, type GoldenEstimate, type LiveExport, type PricedGolden } from './golden';
import { addQuote, newTally, tallyTable, type Tally } from './tally';

const argv = process.argv.slice(2);
// --with-accuracy-rows: price live rows exported before the accuracy migration as they read after it
// (lib/accuracy/rows.ts withAccuracyRows: the dense-pack bag, the batt sizes, the walls waste cell).
const withNewRows = argv.includes('--with-accuracy-rows');
const [mode, ...rest] = argv.filter((a) => a !== '--with-accuracy-rows');
const root = path.resolve(import.meta.dirname, '../..');

function run(estimates: GoldenEstimate[], bundle: PricingBundle): { priced: PricedGolden[]; tally: Tally } {
  const tally = newTally();
  const priced = estimates.map((g) => {
    const p = priceGolden(g, bundle);
    addQuote(tally, p.violations, g.key);
    return p;
  });
  return { priced, tally };
}

const totals = (p: PricedGolden) => Object.fromEntries(p.options.map((o) => [o.tier, o.price])) as Partial<Record<Tier, number>>;
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

if (mode === 'synthetic') {
  const [out] = rest;
  if (!out) throw new Error('Usage: price-golden.ts synthetic <out.json>');
  const set = JSON.parse(fs.readFileSync(path.join(root, 'scripts/accuracy/golden-synthetic.json'), 'utf8')) as { estimates: GoldenEstimate[] };
  const { priced, tally } = run(set.estimates, seededBundle);
  write(out, {
    about: 'The synthetic golden set priced with the seeded setup: every option shown, its items, title and bullets, the headline (OD1) and every rule it breaks.',
    bundle: seededBundle.hash,
    counts: { estimates: tally.checked, failing: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.quotes])), violations: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.violations])) },
    estimates: priced,
  });
  console.log(`Synthetic golden set: ${tally.checked} estimates, seeded bundle ${seededBundle.hash}.\n\n${tallyTable(tally, 'Estimates')}\n\nWrote ${out}`);
} else if (mode === 'live') {
  const [dir, out, summary] = rest;
  if (!dir || !out) throw new Error('Usage: price-golden.ts live <golden dir> <out.json> [<summary.json>]');
  const live = JSON.parse(fs.readFileSync(path.join(dir, 'live-estimates.json'), 'utf8')) as LiveExport;
  const exported = JSON.parse(fs.readFileSync(path.join(dir, 'live-rows.json'), 'utf8')) as SnapshotRows;
  const rows = withNewRows ? withAccuracyRows(exported, seededRows) : exported;
  const bundle = bundleFromRows(rows);
  const validDays = bundle.snapshot.settings.quoteValidDays;
  const { priced, tally } = run(
    live.estimates.map((e) => liveGolden(e, validDays)),
    bundle,
  );

  // What customers were really sent: the stored quotes' own dates, and whether today's engine gives
  // the prices the latest quote was sent with.
  const stored = live.estimates.map((e) => ({ id: e.id, violations: storedValidUntil(e, validDays) }));
  const storedQuotes = live.estimates.reduce((a, e) => a + e.quotes.length, 0);
  const storedLate = stored.reduce((a, s) => a + s.violations.length, 0);
  const reprice = live.estimates
    .filter((e) => e.quotes.length)
    .map((e) => {
      const latest = e.quotes[e.quotes.length - 1]!;
      const now = totals(priced.find((p) => p.id === e.id)!);
      const same = Object.keys(latest.prices).length === Object.keys(now).length && Object.entries(latest.prices).every(([t, v]) => now[t as Tier] === Number(v));
      return { id: e.id, same, sent: latest.prices, today: now, editedAfterSent: !!latest.sentAt && e.updatedAt > latest.sentAt };
    });
  const differs = reprice.filter((r) => !r.same);

  write(out, { about: 'The live golden set priced with the live pricing rows (OUT of git).', bundle: bundle.hash, estimates: priced, stored, reprice });
  const counts = {
    estimates: tally.checked,
    failing: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.quotes])),
    violations: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.violations])),
    violationsByKind: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.byKind])),
    storedQuotes,
    storedQuotesValidUntilOff: storedLate,
    quotedEstimates: reprice.length,
    quotedEstimatesRepricedTheSame: reprice.length - differs.length,
    repricedDifferently: differs.map((r) => ({ id: r.id, sent: r.sent, today: r.today, editedAfterSent: r.editedAfterSent })),
  };
  if (summary) {
    write(summary, {
      about:
        `Live golden set priced by the engine of the commit that wrote it${withNewRows ? ", with the accuracy migration's rows added to the live rows" : ''}: counts, and each estimate's option totals (whole quote price per option shown) keyed by estimate id. No names or addresses. Made by scripts/accuracy/price-golden.ts live from a read-only production export.`,
      bundle: bundle.hash,
      counts,
      totals: Object.fromEntries(priced.map((p) => [p.id, totals(p)])),
    });
  }
  console.log(
    [
      `Live golden set: ${tally.checked} estimates, live bundle ${bundle.hash}${withNewRows ? ' (live rows with the accuracy migration\'s rows added)' : ''}.`,
      '',
      tallyTable(tally, 'Estimates'),
      '',
      `Stored quotes: ${storedQuotes}; ${storedLate} print a "Valid until" date that is not the day their link stops working.`,
      `Quoted estimates: ${reprice.length}; today's engine gives the latest quote's prices for ${reprice.length - differs.length}.`,
      ...differs.map((r) => `  ${r.id.slice(0, 8)}: sent ${JSON.stringify(r.sent)}, today ${JSON.stringify(r.today)}${r.editedAfterSent ? ' (edited after it was sent)' : ''}`),
      '',
      `Wrote ${out}${summary ? ` and ${summary}` : ''}`,
    ].join('\n'),
  );
} else {
  throw new Error('Usage: price-golden.ts synthetic <out.json> | live <golden dir> <out.json> [<summary.json>]');
}
