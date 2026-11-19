// The before/after report on both golden sets (flow stage): prices them on this commit, compares
// them with docs/accuracy/before/, and explains every difference a customer or the office would see
// (an option total, an option no longer shown, the headline, an option's title or bullets) with the
// ledger entries and owner decision behind it. Anything it cannot explain is listed as unexplained.
//
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/report.ts <golden dir> <report.json> <after dir>
//   <golden dir>  the read-only live export (live-estimates.json, live-rows.json, live-priced-before.json),
//                 kept out of git.
//   <report.json> docs/accuracy/report/report.json. The live set keeps estimate ids, statuses and
//                 amounts only: no names, addresses, titles or item words.
//   <after dir>   docs/accuracy/after/: the synthetic set in full and the live set's counts and totals.
//
// Where a change came from: the synthetic set was priced after every stage (docs/accuracy/after-*),
// so each difference is traced to the stage that made it and, within it, to the rule the estimate's
// inputs and the engine's own warnings point at. The live set's totals are traced the same way.
import fs from 'node:fs';
import path from 'node:path';
import { priceEstimate, type PricingBundle, type PricingWarning, type Tier } from '@/lib/pricing';
import { withAccuracyRows } from '@/lib/accuracy/rows';
import { bundleFromRows, seededBundle, seededRows } from '@/lib/pricing/__fixtures__/seeded';
import { headlinePrice } from '@/lib/office/estimates';
import type { SnapshotRows } from '@/lib/server/snapshot';
import { liveGolden, priceGolden, type GoldenEstimate, type LiveExport, type PricedGolden } from './golden';
import { addQuote, newTally } from './tally';

const [goldenDir, reportOut, afterDir] = process.argv.slice(2);
if (!goldenDir || !reportOut || !afterDir) throw new Error('Usage: report.ts <golden dir> <report.json> <after dir>');
const root = path.resolve(import.meta.dirname, '../..');
const read = <T>(p: string): T => JSON.parse(fs.readFileSync(path.isAbsolute(p) ? p : path.join(root, p), 'utf8')) as T;
const write = (file: string, data: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

type Totals = Partial<Record<Tier, number>>;
interface Counts {
  estimates: number;
  failing: Record<string, number>;
  violations: Record<string, number>;
}
interface FullSet {
  counts: Counts;
  estimates: PricedGolden[];
}
interface Change {
  estimate: string;
  status?: string;
  key?: string;
  option: Tier | null;
  what: 'total' | 'not_shown' | 'headline' | 'title' | 'bullets' | 'office_list';
  before: unknown;
  after: unknown;
  why: string;
  ledger: string[];
  ownerDecision: string | null;
  stage: string | null;
}

const TIER_WORDS: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };
const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;

// ---------------------------------------------------------------------------
// Pricing on this commit
// ---------------------------------------------------------------------------

function priceAll(estimates: GoldenEstimate[], bundle: PricingBundle) {
  const tally = newTally();
  const priced = estimates.map((g) => {
    const p = priceGolden(g, bundle);
    addQuote(tally, p.violations, g.key);
    let warnings: PricingWarning[] = [];
    try {
      warnings = g.input.areas.length ? priceEstimate(g.input, bundle.snapshot, bundle.coefficientSet).warnings : [];
    } catch {
      warnings = [];
    }
    return { g, p, warnings };
  });
  const counts: Counts = {
    estimates: tally.checked,
    failing: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.quotes])),
    violations: Object.fromEntries(Object.entries(tally.rules).map(([id, r]) => [id, r.violations])),
  };
  return { priced, counts };
}

// ---------------------------------------------------------------------------
// Why a difference happened
// ---------------------------------------------------------------------------

interface Ctx {
  g: GoldenEstimate;
  warnings: PricingWarning[];
  stage: string | null;
  /** The minimum job price (the "Minimum job charge" line, L2). */
  minimum?: number;
}

const hasExisting = (a: GoldenEstimate['input']['areas'][number]) => (a.currentR ?? 0) > 0 || (a.existingDepthIn ?? 0) > 0 || !!a.existingMaterial;

function explainHidden(c: Ctx, tier: Tier): Why | null {
  const hidden = c.warnings.find((w) => w.code === 'option_hidden' && w.tier === tier);
  if (hidden) {
    // The engine's own reason, as the estimator reads it ("it is the same work as Better", "it costs
    // the same as Best ($1,500), the next option up"), without its advice to the estimator.
    const reason = hidden.message.split(': ').slice(1).join(': ').replace(/ Change its (price|price or its work) to show it\.$/, '').replace(/\.$/, '');
    const kind = /same work as/.test(hidden.message) ? 'it repeats another option' : 'it does not step up';
    return { why: `Not shown to the customer (${kind}): ${reason}. The estimator is told.`, ledger: ['L14'], ownerDecision: 'OD6' };
  }
  const full = c.warnings.find((w) => w.code === 'cavity_full' && (w.tier === tier || w.tier === null));
  if (full) return { why: 'Not priced: the wall cavity is already full of insulation, so nothing more fits.', ledger: ['L19'], ownerDecision: 'OD5' };
  return null;
}

type Why = Omit<Change, 'estimate' | 'option' | 'what' | 'before' | 'after' | 'stage'>;

/** The product an option installs in each area, read from its own items (a package names no product). */
function productsByArea(g: GoldenEstimate, option: PricedGolden['options'][number] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const area of g.input.areas) {
    const words = (option?.items ?? [])
      .filter((i) => i.areaName === area.name)
      .map((i) => i.description)
      .join(' | ');
    out.set(area.id, words);
  }
  return out;
}

/** The rules that moved an option's total in one stage (money: L1-L7, L14-L17; cavity: L18-L24). */
function explainTotalStage(c: Ctx, stage: string, tier: Tier, before: number, after: number, option: PricedGolden['options'][number] | undefined): Why | null {
  const { g } = c;
  if (stage === 'money') {
    if (before < 1 && after >= 1) return { why: 'a typed price under $1 is not used: the model price stands and the estimator is told', ledger: ['L6'], ownerDecision: null };
    if (!Number.isInteger(before) && Number.isInteger(after) && Math.abs(after - before) < 1) {
      return { why: 'a typed price is whole dollars, and the change is its own Price adjustment line', ledger: ['L5', 'L3'], ownerDecision: 'OD4, OD3' };
    }
    if (Object.values(g.input.lineOverrides ?? {}).some((o) => !o.tier || o.tier === tier)) {
      return { why: 'install labor is priced for the quantity the estimator priced, not the model quantity', ledger: ['L7'], ownerDecision: null };
    }
    return null;
  }
  if (stage === 'cavity') {
    const reasons: string[] = [];
    const ledger: string[] = [];
    const od = new Set<string>();
    const products = productsByArea(g, option);
    for (const area of g.input.areas) {
      const words = products.get(area.id) ?? '';
      if (!words) continue;
      if (area.jobType === 'walls' && /Cellulose/.test(words)) {
        reasons.push(`the ${area.name.toLowerCase()} are blown dense: a 25 lb bag covers 35 sq ft of a 2x4 wall and fills the cavity`);
        ledger.push('L20');
        od.add('OD7');
        if (area.depthIn === null) {
          ledger.push('L18');
          od.add('OD5');
        }
      } else if (area.jobType === 'walls' && /Spray Foam|Open-Cell|Closed-Cell/.test(words) && area.depthIn === null) {
        reasons.push(`the ${area.name.toLowerCase()} have no depth entered, so they are a 2x4 (3.5 in) and the foam fills 3.5 in, not 5.4 in to R-20`);
        ledger.push('L18');
        od.add('OD5');
      }
      if (['walls', 'rim_joist', 'crawlspace', 'garage'].includes(area.jobType) && hasExisting(area)) {
        reasons.push(`the insulation already in the ${area.name.toLowerCase()} takes its room in the cavity`);
        ledger.push('L19');
        od.add('OD5');
      }
      if (/Batts/.test(words)) {
        reasons.push(`the ${area.name.toLowerCase()} batt is the size whose R-value and thickness fit`);
        ledger.push('L22');
        od.add('OD8');
      }
    }
    if (Object.values(g.input.lineOverrides ?? {}).some((o) => !o.tier || o.tier === tier)) {
      reasons.push("the estimator's bag count is cut to what fills the cavity, and the R it states is capped at the cavity");
      ledger.push('L23', 'L23b');
    }
    if (ledger.length === 0) return null;
    if (after === c.minimum || before === c.minimum) {
      reasons.push('the minimum job charge is its own line');
      ledger.push('L2');
    }
    return { why: [...new Set(reasons)].join('; '), ledger: [...new Set(ledger)], ownerDecision: [...od].join(', ') || null };
  }
  return null;
}

/** Every stage that moved an option's total, each explained; null when one of them cannot be. */
function explainTotal(c: Ctx, tier: Tier, steps: Array<{ stage: string; before: number; after: number }>, option: PricedGolden['options'][number] | undefined): Why | null {
  const parts = steps.map((st) => ({ st, why: explainTotalStage(c, st.stage, tier, st.before, st.after, option) }));
  if (parts.some((p) => !p.why)) return null;
  const why =
    parts.length === 1
      ? parts[0]!.why!.why
      : parts.map((p) => `${p.st.stage} stage (${usd(p.st.before)} -> ${usd(p.st.after)}): ${p.why!.why}`).join('; ');
  const od = [...new Set(parts.flatMap((p) => (p.why!.ownerDecision ?? '').split(', ').filter(Boolean)))];
  return { why: `${why.charAt(0).toUpperCase()}${why.slice(1)}.`, ledger: [...new Set(parts.flatMap((p) => p.why!.ledger))], ownerDecision: od.join(', ') || null };
}

function explainText(stage: string | null, what: 'title' | 'bullets', before: string | string[], after: string | string[]): Why | null {
  const b = Array.isArray(before) ? before.join(' | ') : before;
  const a = Array.isArray(after) ? after.join(' | ') : after;
  if (stage === 'money') {
    if (what === 'title') return { why: 'The title says only the work that is priced.', ledger: ['L15'], ownerDecision: null };
    return { why: 'The bullets promise only work that is priced in this option.', ledger: ['L15'], ownerDecision: null };
  }
  if (stage === 'cavity') {
    if (/Fills the full cavity/.test(b) && !/Fills the full cavity/.test(a)) {
      return { why: '"Fills the full cavity" is said only when the cavity is filled.', ledger: ['L23'], ownerDecision: null };
    }
    if (/Batts/i.test(a)) return { why: 'Batts are named by the size priced, which fits the cavity.', ledger: ['L22'], ownerDecision: 'OD8' };
    if (/code/i.test(b) && !/code/i.test(a)) return { why: '"Code" is said only when the area reaches the code minimum.', ledger: ['L15', 'L18'], ownerDecision: 'OD5' };
    return { why: 'The words follow the insulation that fits the cavity.', ledger: ['L18', 'L19'], ownerDecision: 'OD5' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparing one set
// ---------------------------------------------------------------------------

interface StageView {
  name: string;
  totals: (id: string) => Totals | null;
  full?: (id: string) => PricedGolden | null;
}

/** Each stage after which the value differs from the stage before it, with the values. */
function stepsOf<T>(stages: StageView[], pick: (s: StageView) => T): Array<{ stage: string; before: T; after: T }> {
  const out: Array<{ stage: string; before: T; after: T }> = [];
  for (let i = 1; i < stages.length; i++) {
    const before = pick(stages[i - 1]!);
    const after = pick(stages[i]!);
    if (JSON.stringify(after) !== JSON.stringify(before)) out.push({ stage: stages[i]!.name, before, after });
  }
  return out;
}

function stageOf(stages: StageView[], id: string, pick: (s: StageView) => unknown): string | null {
  // The first stage after which the value differs from the one before it.
  let prev = pick(stages[0]!);
  for (let i = 1; i < stages.length; i++) {
    const cur = pick(stages[i]!);
    if (JSON.stringify(cur) !== JSON.stringify(prev)) return stages[i]!.name;
    prev = cur;
  }
  return null;
}

function compare(
  name: 'synthetic' | 'live',
  before: { counts: Counts; byId: Map<string, PricedGolden> },
  now: ReturnType<typeof priceAll>,
  stages: StageView[],
  status: (id: string) => string | undefined,
  minimum: number,
) {
  const changes: Change[] = [];
  let unchanged = 0;
  let moved = 0;
  let notShown = 0;
  let newlyShown = 0;
  let headlineBefore = 0;
  let headlineAfter = 0;
  const live = name === 'live';
  for (const { g, p, warnings } of now.priced) {
    const b = before.byId.get(g.id);
    if (!b) throw new Error(`${name}: ${g.id} is not in the before set`);
    const base = { estimate: g.id, ...(live ? { status: status(g.id) } : { key: g.key }) };
    const bo = new Map(b.options.map((o) => [o.tier, o]));
    const ao = new Map(p.options.map((o) => [o.tier, o]));
    headlineBefore += b.headline?.price ?? 0;
    headlineAfter += p.headline?.price ?? 0;
    for (const [tier, o] of bo) {
      const a = ao.get(tier);
      const totalStage = stageOf(stages, g.id, (s) => s.totals(g.id)?.[tier] ?? null);
      if (!a) {
        notShown++;
        const ex = explainHidden({ g, warnings, stage: totalStage }, tier);
        changes.push({ ...base, option: tier, what: 'not_shown', before: o.price, after: null, stage: totalStage, ...(ex ?? { why: 'UNEXPLAINED', ledger: [], ownerDecision: null }) });
        continue;
      }
      if (Math.abs(a.price - o.price) > 0.001) {
        moved++;
        const steps = stepsOf(stages, (s) => s.totals(g.id)?.[tier] ?? null).filter((x): x is { stage: string; before: number; after: number } => x.before !== null && x.after !== null);
        const ex = explainTotal({ g, warnings, stage: totalStage, minimum }, tier, steps, a);
        changes.push({
          ...base,
          option: tier,
          what: 'total',
          before: o.price,
          after: a.price,
          stage: steps.map((x) => x.stage).join(', ') || null,
          ...(ex ?? { why: 'UNEXPLAINED', ledger: [], ownerDecision: null }),
        });
      } else unchanged++;
      if (a.label !== o.label) {
        const st = stageOf(stages, g.id, (s) => s.full?.(g.id)?.options.find((x) => x.tier === tier)?.label ?? null) ?? (live ? (/Batts/.test(a.label) ? 'cavity' : 'money') : null);
        const ex = explainText(st, 'title', o.label, a.label);
        changes.push({ ...base, option: tier, what: 'title', before: live ? null : o.label, after: live ? null : a.label, stage: st, ...(ex ?? { why: 'UNEXPLAINED', ledger: [], ownerDecision: null }) });
      }
      if (JSON.stringify(a.bullets) !== JSON.stringify(o.bullets)) {
        const st =
          stageOf(stages, g.id, (s) => s.full?.(g.id)?.options.find((x) => x.tier === tier)?.bullets ?? null) ??
          (live ? (o.bullets.some((x) => /Fills the full cavity/.test(x)) ? 'cavity' : 'money') : null);
        const ex = explainText(st, 'bullets', o.bullets, a.bullets);
        changes.push({
          ...base,
          option: tier,
          what: 'bullets',
          before: live ? o.bullets.length : o.bullets,
          after: live ? a.bullets.length : a.bullets,
          stage: st,
          ...(ex ?? { why: 'UNEXPLAINED', ledger: [], ownerDecision: null }),
        });
      }
    }
    for (const tier of ao.keys()) if (!bo.has(tier)) newlyShown++;
    // The headline (OD1): the recommended option's price.
    const hb = b.headline;
    const ha = p.headline;
    if ((hb?.tier ?? null) !== (ha?.tier ?? null) || (hb?.price ?? null) !== (ha?.price ?? null)) {
      let ex: Why;
      if (!ha) ex = { why: 'No option can be priced (the cavity is full), so there is no headline.', ledger: ['L19'], ownerDecision: 'OD5' };
      else if (hb && hb.tier !== ha.tier && !ao.has(hb.tier)) {
        ex = {
          why: `${TIER_WORDS[hb.tier]} is no longer shown, so the recommended option is ${TIER_WORDS[ha.tier]}${ha.price === hb.price ? ', at the same price' : ''}.`,
          ledger: ['L14', 'L9'],
          ownerDecision: 'OD6, OD1',
        };
      } else if (hb && hb.tier === ha.tier) {
        const c = changes.find((x) => x.estimate === g.id && x.option === ha.tier && x.what === 'total');
        ex = c ? { why: `The recommended option's total moved: ${c.why}`, ledger: c.ledger, ownerDecision: c.ownerDecision } : { why: 'UNEXPLAINED', ledger: [], ownerDecision: null };
      } else ex = { why: 'UNEXPLAINED', ledger: [], ownerDecision: null };
      changes.push({
        ...base,
        option: ha?.tier ?? null,
        what: 'headline',
        before: hb ? (live ? hb.price : `${TIER_WORDS[hb.tier]} ${usd(hb.price)}`) : null,
        after: ha ? (live ? ha.price : `${TIER_WORDS[ha.tier]} ${usd(ha.price)}`) : null,
        stage: stageOf(stages, g.id, (s) => s.full?.(g.id)?.headline ?? s.totals(g.id)) ?? null,
        ...ex,
      });
    }
  }
  const unexplained = changes.filter((c) => c.why === 'UNEXPLAINED');
  return {
    estimates: now.counts.estimates,
    violations: { before: before.counts, after: now.counts },
    optionTotals: { unchanged, moved, notShown, newlyShown },
    headlineSum: { before: Math.round(headlineBefore * 100) / 100, after: Math.round(headlineAfter * 100) / 100 },
    changes,
    unexplained: unexplained.length,
  };
}

// ---------------------------------------------------------------------------
// The two sets
// ---------------------------------------------------------------------------

const byId = (set: FullSet) => new Map(set.estimates.map((e) => [e.id, e]));
const totalsOf = (e: PricedGolden | null | undefined): Totals | null => (e ? Object.fromEntries(e.options.map((o) => [o.tier, o.price])) : null);

// Synthetic: before (in full), each stage after (in full), now.
const synthBefore = read<FullSet>('docs/accuracy/before/golden-synthetic-before.json');
const synthStages = ['money', 'cavity', 'quotes'].map((s) => ({ name: s, set: byId(read<FullSet>(`docs/accuracy/after-${s}/golden-synthetic-after-${s}.json`)) }));
const synthSet = read<{ estimates: GoldenEstimate[] }>('scripts/accuracy/golden-synthetic.json');
const synthNow = priceAll(synthSet.estimates, seededBundle);
const synthNowById = new Map(synthNow.priced.map((x) => [x.p.id, x.p]));
const synthView = (name: string, m: Map<string, PricedGolden>): StageView => ({ name, totals: (id) => totalsOf(m.get(id)), full: (id) => m.get(id) ?? null });
const synthReport = compare(
  'synthetic',
  { counts: synthBefore.counts, byId: byId(synthBefore) },
  synthNow,
  [synthView('before', byId(synthBefore)), ...synthStages.map((s) => synthView(s.name, s.set)), synthView('flow', synthNowById)],
  () => undefined,
  seededBundle.snapshot.settings.minimumJobPrice,
);

// Live: before in full (out of git), each stage's totals (committed), now.
const liveExport = read<LiveExport>(path.join(goldenDir, 'live-estimates.json'));
const liveRows = withAccuracyRows(read<SnapshotRows>(path.join(goldenDir, 'live-rows.json')), seededRows);
const liveBundle = bundleFromRows(liveRows);
const liveBeforeFull = read<FullSet>(path.join(goldenDir, 'live-priced-before.json'));
const liveBeforeSummary = read<{ counts: Counts; totals: Record<string, Totals> }>('docs/accuracy/before/golden-live-before.json');
const liveStages = ['money', 'cavity', 'quotes'].map((s) => ({ name: s, totals: read<{ totals: Record<string, Totals> }>(`docs/accuracy/after-${s}/golden-live-after-${s}.json`).totals }));
const liveNow = priceAll(
  liveExport.estimates.map((e) => liveGolden(e, liveBundle.snapshot.settings.quoteValidDays)),
  liveBundle,
);
const liveNowTotals = Object.fromEntries(liveNow.priced.map((x) => [x.p.id, totalsOf(x.p)]));
const statusById = new Map(liveExport.estimates.map((e) => [e.id, e.status]));
const liveReport = compare(
  'live',
  { counts: liveBeforeSummary.counts, byId: byId(liveBeforeFull) },
  liveNow,
  [
    { name: 'before', totals: (id) => liveBeforeSummary.totals[id] ?? null },
    ...liveStages.map((s) => ({ name: s.name, totals: (id: string) => s.totals[id] ?? null })),
    { name: 'flow', totals: (id) => liveNowTotals[id] ?? null },
  ],
  (id) => statusById.get(id),
  liveBundle.snapshot.settings.minimumJobPrice,
);

// The office Estimates list reads the stored options (not a new pricing): before L9 it showed the
// picked option, else the stored model price; now the recommended option (OD1), like the phone and
// the quote. A signed estimate shows its signed price, before and after.
const officeList: Change[] = [];
for (const e of liveExport.estimates) {
  const latest = e.quotes[e.quotes.length - 1];
  const signedPrice = latest?.status === 'signed' || e.status === 'signed' ? (latest?.signedPrice ?? null) : null;
  const stored = e.options.map((o) => ({ tier: o.tier, price: o.price }));
  const isPrice = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
  const old =
    isPrice(signedPrice) ? signedPrice : (stored.find((o) => o.tier === e.selectedTier && isPrice(o.price))?.price ?? (isPrice(e.modelTotalPrice) ? e.modelTotalPrice : null));
  const now = headlinePrice({ selectedTier: e.selectedTier, options: stored, modelTotalPrice: e.modelTotalPrice, signedPrice });
  if (old !== now.price) {
    officeList.push({
      estimate: e.id,
      status: e.status,
      option: (now.tier as Tier | null) ?? null,
      what: 'office_list',
      before: old,
      after: now.price,
      why: "The office list shows the recommended option's price (the pick, else Better) instead of the stored model price, like the phone and the quote.",
      ledger: ['L9'],
      ownerDecision: 'OD1',
      stage: 'quotes',
    });
  }
}

// The live set's committed form keeps ids, statuses and amounts only.
const liveChanges = [...liveReport.changes, ...officeList].map((c) => ({ estimate: c.estimate, status: c.status, option: c.option, what: c.what, before: c.before, after: c.after, why: c.why, ledger: c.ledger, ownerDecision: c.ownerDecision, stage: c.stage }));

write(reportOut, {
  about:
    'Before/after report on the golden sets (flow stage). Before: docs/accuracy/before/ (the code before any fix). After: this commit, priced by scripts/accuracy/report.ts. Every difference a customer or the office would see is listed with the ledger entries (docs/accuracy/ledger.txt) and the owner decision behind it; "stage" is the stage that made it. The live set keeps estimate ids, statuses and amounts only.',
  sets: {
    synthetic: { ...synthReport, bundle: seededBundle.hash },
    live: { ...liveReport, changes: liveChanges, officeListMoved: officeList.length, bundle: liveBundle.hash, export: { estimates: liveExport.estimates.length } },
  },
  unexplained: synthReport.unexplained + liveReport.unexplained,
});

// After files: the synthetic set in full, the live set's counts and totals by id.
write(path.join(afterDir, 'golden-synthetic-after.json'), {
  about: 'The synthetic golden set priced on the final commit of Phase 1 (flow stage) with the seeded setup.',
  bundle: seededBundle.hash,
  counts: synthNow.counts,
  estimates: synthNow.priced.map((x) => x.p),
});
write(path.join(afterDir, 'golden-live-after.json'), {
  about:
    "Live golden set priced on the final commit of Phase 1 (flow stage), with the accuracy migration's rows added to the live rows: counts, and each estimate's option totals keyed by estimate id. No names or addresses.",
  bundle: liveBundle.hash,
  counts: liveNow.counts,
  totals: liveNowTotals,
});

const line = (n: string, r: typeof synthReport) =>
  `${n}: ${r.estimates} estimates; options unchanged ${r.optionTotals.unchanged}, moved ${r.optionTotals.moved}, no longer shown ${r.optionTotals.notShown}, newly shown ${r.optionTotals.newlyShown}; headline sum ${usd(r.headlineSum.before)} -> ${usd(r.headlineSum.after)}; changes ${r.changes.length}, unexplained ${r.unexplained}`;
console.log([line('Synthetic', synthReport), line('Live', liveReport), `Live office list headlines moved: ${officeList.map((c) => `${c.estimate.slice(0, 8)} ${usd(Number(c.before))} -> ${usd(Number(c.after))}`).join(', ') || 'none'}`, `Wrote ${reportOut} and ${afterDir}`].join('\n'));
for (const c of [...synthReport.changes, ...liveReport.changes].filter((x) => x.why === 'UNEXPLAINED')) console.log('UNEXPLAINED', JSON.stringify(c));
