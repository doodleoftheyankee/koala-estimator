// The synthetic golden set: typical jobs and the edge cases the audit found, written out by hand so
// a person can read each one. Writes scripts/accuracy/golden-synthetic.json (committed).
// Usage: node scripts/accuracy/run.mjs scripts/accuracy/make-synthetic.ts
//
// Unless an estimate says otherwise: moderate access, a 20-minute drive, no crew picked, quoted on
// 2026-06-15 at 2 PM UTC for 30 days. With those, the seeded setup prices the round 1 record's
// synthetic examples as the record says (walls 1,000 sq ft with no depth: Better $3,795).
import fs from 'node:fs';
import path from 'node:path';
import { stableId } from '@/lib/accuracy/rows';
import type { AreaInput, EstimateInput, LineOverride, PriceOverride, Tier } from '@/lib/pricing';
import { lineKey } from '@/lib/pricing';
import type { GoldenEstimate } from './golden';

type Area = Partial<AreaInput> & Pick<AreaInput, 'jobType' | 'sqft'>;
interface Spec {
  key: string;
  title: string;
  areas: Area[];
  drive?: number | null;
  crewId?: string | null;
  overrides?: Partial<Record<Tier, PriceOverride>>;
  /** Line overrides by area index: [areaIndex, product, kind, override]. */
  lines?: Array<[number, Parameters<typeof lineKey>[1], Parameters<typeof lineKey>[2], LineOverride]>;
  selectedTier?: Tier | null;
  issuedAt?: string;
  validDays?: number;
}

const NAMES: Record<AreaInput['jobType'], string> = {
  attic: 'Attic',
  walls: 'Exterior walls',
  crawlspace: 'Crawlspace',
  rim_joist: 'Basement rim joist',
  garage: 'Garage',
  commercial: 'Commercial area',
};

const reason = 'Estimator change';
const SPECS: Spec[] = [
  // --- The audit's own examples (S1-F1 .. S1-F9) ---
  { key: 'S1-F1', title: 'A price typed with cents: Good set to $4,321.50', areas: [{ jobType: 'attic', sqft: 1300, currentR: 11 }], overrides: { good: { price: 4321.5, reason } } },
  { key: 'S1-F2', title: 'Two garages and a crawlspace: items printed one by one', areas: [{ jobType: 'garage', sqft: 1002 }, { jobType: 'garage', sqft: 2526, name: 'Garage 2' }, { jobType: 'crawlspace', sqft: 368 }] },
  { key: 'S1-F3', title: 'Attic with old insulation out, plus walls: the same removal in every option', areas: [{ jobType: 'attic', sqft: 1200, currentR: 19, existingMaterial: 'Blown fiberglass', removalNeeded: true }, { jobType: 'walls', sqft: 1400, depthIn: 3.5 }] },
  { key: 'S1-F4', title: 'Walls 1,000 sq ft with no depth entered', areas: [{ jobType: 'walls', sqft: 1000 }] },
  { key: 'S1-F5', title: 'Walls 800 sq ft (2x4) with 2 in of cellulose already in them', areas: [{ jobType: 'walls', sqft: 800, depthIn: 3.5, currentR: 7, existingMaterial: 'Cellulose', existingDepthIn: 2 }] },
  { key: 'S1-F6', title: 'Crawlspace 800 sq ft, 2x6 floor, target R-38', areas: [{ jobType: 'crawlspace', sqft: 800, depthIn: 5.5, targetR: 38 }] },
  { key: 'S1-F7a', title: 'Attic 1,200 sq ft, no insulation: Best repeats Better', areas: [{ jobType: 'attic', sqft: 1200 }] },
  { key: 'S1-F7b', title: 'Attic at R-11, target R-30: "to Code" below code', areas: [{ jobType: 'attic', sqft: 1000, currentR: 11, existingMaterial: 'Fiberglass batts', targetR: 30 }] },
  { key: 'S1-F7c', title: 'Crawlspace already at R-19: only air sealing is new in Best', areas: [{ jobType: 'crawlspace', sqft: 900, currentR: 19, existingMaterial: 'Fiberglass batts' }] },
  { key: 'S1-F8', title: 'Sent at 9:30 PM business time (02:30 UTC the next day): Valid until', areas: [{ jobType: 'attic', sqft: 1100, currentR: 13 }], issuedAt: '2026-11-18T02:30:00.000Z' },
  { key: 'S1-F9', title: 'Dense-pack walls 2,200 sq ft, 2x4, long drive', areas: [{ jobType: 'walls', sqft: 2200, depthIn: 3.5 }], drive: 60 },
  { key: 'S1-F9b', title: 'Dense-pack walls 1,400 sq ft, 2x6', areas: [{ jobType: 'walls', sqft: 1400, depthIn: 5.5 }], drive: 25 },

  // --- Examples from the round 1 record ---
  { key: 'R-walls-650', title: 'Walls 650 sq ft, difficult access', areas: [{ jobType: 'walls', sqft: 650, accessLevel: 'difficult' }], drive: 15 },
  { key: 'R-walls-400-down', title: 'Walls 400 sq ft, Good 10% down', areas: [{ jobType: 'walls', sqft: 400 }], overrides: { good: { price: 1350, reason } } },
  { key: 'R-walls-bags-up', title: 'Walls 1,000 sq ft, Good bag count +20%', areas: [{ jobType: 'walls', sqft: 1000 }], lines: [[0, 'cellulose', 'material', { qty: 37, reason, tier: 'good' }]] },
  { key: 'R-wet-walls', title: 'Wet walls 1,200 sq ft (2x4): old batts out', areas: [{ jobType: 'walls', sqft: 1200, depthIn: 3.5, currentR: 11, existingMaterial: 'Fiberglass batts', removalNeeded: true }] },
  { key: 'R-attic-walls-rim', title: 'Attic, walls 900 sq ft and a rim joist 160 sq ft', areas: [{ jobType: 'attic', sqft: 900, currentR: 11 }, { jobType: 'walls', sqft: 900 }, { jobType: 'rim_joist', sqft: 160 }] },
  { key: 'R-L3', title: 'Attic 900 sq ft at R-19, Better set to $3,000', areas: [{ jobType: 'attic', sqft: 900, currentR: 19, accessLevel: 'easy' }], overrides: { better: { price: 3000, reason } } },
  { key: 'R-L6', title: 'Attic 900 sq ft, Good set to $0.40', areas: [{ jobType: 'attic', sqft: 900, accessLevel: 'easy' }], overrides: { good: { price: 0.4, reason } } },
  { key: 'R-L17', title: 'Attic 0.3 sq ft', areas: [{ jobType: 'attic', sqft: 0.3 }] },
  { key: 'R-L19', title: 'Walls 1,000 sq ft (2x4) full of R-11 batts', areas: [{ jobType: 'walls', sqft: 1000, depthIn: 3.5, currentR: 11, existingMaterial: 'Fiberglass batts', accessLevel: 'easy' }] },
  { key: 'R-L20', title: 'Walls 1,000 sq ft (2x6), target R-13', areas: [{ jobType: 'walls', sqft: 1000, depthIn: 5.5, targetR: 13, accessLevel: 'easy' }] },
  { key: 'R-rim-min', title: 'Rim joist 180 sq ft: every option at the minimum job price', areas: [{ jobType: 'rim_joist', sqft: 180 }] },
  { key: 'R-rim-one-price', title: 'Rim joist 220 sq ft: the estimator set all three to one price', areas: [{ jobType: 'rim_joist', sqft: 220 }], overrides: { good: { price: 1800, reason }, better: { price: 1800, reason }, best: { price: 1800, reason } } },

  // --- Typical jobs ---
  { key: 'T01', title: 'Attic 1,500 sq ft, R-11', areas: [{ jobType: 'attic', sqft: 1500, currentR: 11, existingMaterial: 'Fiberglass batts' }], selectedTier: 'better' },
  { key: 'T02', title: 'Attic 2,200 sq ft, R-19, easy', areas: [{ jobType: 'attic', sqft: 2200, currentR: 19, accessLevel: 'easy' }], selectedTier: 'better' },
  { key: 'T03', title: 'Attic 850 sq ft, R-30, scuttle', areas: [{ jobType: 'attic', sqft: 850, currentR: 30, existingMaterial: 'Blown fiberglass' }] },
  { key: 'T04', title: 'Attic 1,800 sq ft, vermiculite out', areas: [{ jobType: 'attic', sqft: 1800, currentR: 7, existingMaterial: 'Vermiculite', removalNeeded: true, accessLevel: 'difficult' }], selectedTier: 'best' },
  { key: 'T05', title: 'Attic 1,250 sq ft, rodent damage, removal', areas: [{ jobType: 'attic', sqft: 1250, currentR: 13, existingMaterial: 'Cellulose', removalNeeded: true }], selectedTier: 'best' },
  { key: 'T06', title: 'Attic 1,000 sq ft, R-38 already', areas: [{ jobType: 'attic', sqft: 1000, currentR: 38, existingMaterial: 'Blown fiberglass' }] },
  { key: 'T07', title: 'Walls 1,600 sq ft (2x4), empty', areas: [{ jobType: 'walls', sqft: 1600, depthIn: 3.5 }], selectedTier: 'good' },
  { key: 'T08', title: 'Walls 900 sq ft (2x6), empty', areas: [{ jobType: 'walls', sqft: 900, depthIn: 5.5 }] },
  { key: 'T09', title: 'Walls 2,400 sq ft, no depth entered', areas: [{ jobType: 'walls', sqft: 2400 }] },
  { key: 'T10', title: 'Crawlspace 1,100 sq ft (2x8)', areas: [{ jobType: 'crawlspace', sqft: 1100, depthIn: 7.25 }], selectedTier: 'better' },
  { key: 'T11', title: 'Crawlspace 600 sq ft, no depth', areas: [{ jobType: 'crawlspace', sqft: 600, accessLevel: 'extreme' }] },
  { key: 'T12', title: 'Rim joist 140 sq ft', areas: [{ jobType: 'rim_joist', sqft: 140, depthIn: 9.25 }] },
  { key: 'T13', title: 'Rim joist 320 sq ft, R-11 batts already', areas: [{ jobType: 'rim_joist', sqft: 320, currentR: 11, existingMaterial: 'Fiberglass batts' }] },
  { key: 'T14', title: 'Garage ceiling 480 sq ft', areas: [{ jobType: 'garage', sqft: 480 }], selectedTier: 'good' },
  { key: 'T15', title: 'Garage 650 sq ft (2x6 ceiling)', areas: [{ jobType: 'garage', sqft: 650, depthIn: 5.5 }] },
  { key: 'T16', title: 'Commercial 6,000 sq ft', areas: [{ jobType: 'commercial', sqft: 6000 }], drive: 45 },
  { key: 'T17', title: 'Commercial 14,500 sq ft, R-19 target', areas: [{ jobType: 'commercial', sqft: 14500, targetR: 19 }], drive: 35 },
  { key: 'T18', title: 'Attic 1,400 sq ft and rim joist 150 sq ft', areas: [{ jobType: 'attic', sqft: 1400, currentR: 11 }, { jobType: 'rim_joist', sqft: 150 }], selectedTier: 'better' },
  { key: 'T19', title: 'Crawlspace 800 sq ft and rim joist 120 sq ft', areas: [{ jobType: 'crawlspace', sqft: 800, depthIn: 9.25 }, { jobType: 'rim_joist', sqft: 120 }] },
  { key: 'T20', title: 'Attic 1,600 sq ft and walls 1,200 sq ft (2x4)', areas: [{ jobType: 'attic', sqft: 1600, currentR: 19 }, { jobType: 'walls', sqft: 1200, depthIn: 3.5 }] },
  { key: 'T21', title: 'Two attics (house and addition)', areas: [{ jobType: 'attic', sqft: 1300, currentR: 11 }, { jobType: 'attic', sqft: 420, name: 'Addition attic' }] },
  { key: 'T22', title: 'Whole house: attic, walls, crawlspace, rim joist', areas: [{ jobType: 'attic', sqft: 1500, currentR: 13 }, { jobType: 'walls', sqft: 1700, depthIn: 3.5 }, { jobType: 'crawlspace', sqft: 900, depthIn: 7.25 }, { jobType: 'rim_joist', sqft: 160 }], selectedTier: 'better' },
  { key: 'T23', title: 'Attic 1,000 sq ft, crew picked', areas: [{ jobType: 'attic', sqft: 1000, currentR: 11 }], crewId: 'default' },
  { key: 'T24', title: 'Attic 1,700 sq ft, Better 8% up with a reason', areas: [{ jobType: 'attic', sqft: 1700, currentR: 19 }], overrides: { better: { price: 5600, reason } }, selectedTier: 'better' },
  { key: 'T25', title: 'Walls 1,000 sq ft (2x4), labor hours +40% on Better', areas: [{ jobType: 'walls', sqft: 1000, depthIn: 3.5 }], lines: [[0, 'ocsf', 'labor', { hours: 14, reason, tier: 'better' }]] },

  // --- Edge cases ---
  { key: 'E01', title: 'Walls 9 sq ft (a patch)', areas: [{ jobType: 'walls', sqft: 9, depthIn: 3.5 }] },
  { key: 'E02', title: 'Attic 200,000 sq ft (the size cap)', areas: [{ jobType: 'attic', sqft: 200000 }], drive: 90 },
  { key: 'E03', title: 'Commercial 200,000 sq ft, extreme access', areas: [{ jobType: 'commercial', sqft: 200000, accessLevel: 'extreme' }], drive: 180 },
  { key: 'E04', title: 'No drive time entered', areas: [{ jobType: 'attic', sqft: 1100, currentR: 11 }], drive: null },
  { key: 'E05', title: 'Drive time 0 (next door)', areas: [{ jobType: 'attic', sqft: 1100, currentR: 11 }], drive: 0 },
  { key: 'E06', title: 'Drive time 600 min (the limit)', areas: [{ jobType: 'crawlspace', sqft: 700 }], drive: 600 },
  { key: 'E07', title: 'A crew id that is not in the setup', areas: [{ jobType: 'attic', sqft: 1100, currentR: 11 }], crewId: 'missing' },
  { key: 'E08', title: 'Existing material in lower case, no depth', areas: [{ jobType: 'walls', sqft: 900, depthIn: 3.5, currentR: 7, existingMaterial: 'cellulose' }] },
  { key: 'E09', title: 'Existing insulation with a depth but no R-value', areas: [{ jobType: 'walls', sqft: 900, depthIn: 3.5, existingMaterial: 'Rock wool', existingDepthIn: 3 }] },
  { key: 'E10', title: 'Attic target above code (R-70)', areas: [{ jobType: 'attic', sqft: 1200, targetR: 70 }] },
  { key: 'E11', title: 'Good 30% up with cents', areas: [{ jobType: 'attic', sqft: 1200, currentR: 11 }], overrides: { good: { price: 4999.99, reason } } },
  { key: 'E12', title: 'Best 30% down', areas: [{ jobType: 'crawlspace', sqft: 1000, depthIn: 7.25 }], overrides: { best: { price: 4200, reason } }, selectedTier: 'best' },
  { key: 'E13', title: 'Picked Good where Good is not offered (attic already at code)', areas: [{ jobType: 'attic', sqft: 1000, currentR: 49, existingMaterial: 'Blown fiberglass' }], selectedTier: 'good' },
  { key: 'E14', title: 'Sent at 6:59 PM business time on Dec 31 (UTC is already the new year)', areas: [{ jobType: 'attic', sqft: 1000, currentR: 11 }], issuedAt: '2026-12-31T23:59:00.000Z' },
  { key: 'E15', title: 'Sent on the night clocks go back', areas: [{ jobType: 'attic', sqft: 1000, currentR: 11 }], issuedAt: '2026-11-01T04:30:00.000Z', validDays: 7 },
  { key: 'E16', title: 'Sent the night clocks go forward, valid 60 days', areas: [{ jobType: 'attic', sqft: 1000, currentR: 11 }], issuedAt: '2026-03-08T03:30:00.000Z', validDays: 60 },
];

const root = path.resolve(import.meta.dirname, '../..');
const DEFAULT_ISSUED = '2026-06-15T14:00:00.000Z';
const crewFor = (c: Spec['crewId']) => (c === 'default' ? stableId('crew:Crew A') : c === 'missing' ? stableId('crew:not in the setup') : (c ?? null));

const estimates: GoldenEstimate[] = SPECS.map((s) => {
  const id = stableId(`synthetic:${s.key}`);
  const areas: AreaInput[] = s.areas.map((a, i) => ({
    id: stableId(`synthetic:${s.key}:area${i + 1}`),
    name: a.name ?? NAMES[a.jobType],
    jobType: a.jobType,
    sqft: a.sqft,
    currentR: a.currentR ?? 0,
    targetR: a.targetR ?? null,
    existingMaterial: a.existingMaterial ?? null,
    existingDepthIn: a.existingDepthIn ?? null,
    depthIn: a.depthIn ?? null,
    accessLevel: a.accessLevel ?? 'moderate',
    removalNeeded: a.removalNeeded ?? false,
    prepNotes: null,
  }));
  const lineOverrides = Object.fromEntries((s.lines ?? []).map(([i, product, kind, o]) => [lineKey(areas[i]!.id, product, kind), o]));
  const input: EstimateInput = {
    areas,
    crewId: crewFor(s.crewId),
    driveMinutesOneWay: s.drive === undefined ? 20 : s.drive,
    overrides: s.overrides ?? {},
    lineOverrides,
  };
  return { key: s.key, id, title: s.title, input, selectedTier: s.selectedTier ?? null, issuedAt: s.issuedAt ?? DEFAULT_ISSUED, validDays: s.validDays ?? 30 };
});

const out = path.join(root, 'scripts/accuracy/golden-synthetic.json');
fs.writeFileSync(out, `${JSON.stringify({ about: 'Synthetic golden set: typical jobs and audit edge cases. Generated by scripts/accuracy/make-synthetic.ts; edit that file, not this one.', estimates }, null, 2)}\n`);
console.log(`${estimates.length} synthetic estimates -> ${path.relative(root, out)}`);
