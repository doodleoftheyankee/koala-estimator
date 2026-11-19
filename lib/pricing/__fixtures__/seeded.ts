// The pricing setup a new database starts with: the rows every migration in supabase/migrations
// leaves behind (seeded-rows.json, built by scripts/accuracy/seeded-rows.sh from a freshly migrated
// database; ids are made from what each row is, so they never change between runs). Only the
// pricing settings are kept (lib/accuracy/rows.ts PRICING_SETTING_KEYS): no branding or franchise text.
//
// This is what the live site prices with until the owner edits a value, so the accuracy checks
// (lib/pricing/invariants.ts, scripts/accuracy/) price with it. The older hand-made fixture in
// seed.ts (attic R-60, overhead 0.20) is not the live setup; it stays for the engine's own tests.
//
// After a migration that changes a seeded value, regenerate the JSON:
//   DATABASE_URL=... bash scripts/accuracy/seeded-rows.sh
import type { PricingBundle } from '../types';
import { validateSnapshot } from '../engine';
import { makeBundle, type SnapshotRows } from '@/lib/server/snapshot';
import rows from './seeded-rows.json';

/** A fixed build time, so the bundle (and its hash) is the same on every run. */
const BUILT_AT = new Date('2026-11-18T00:00:00.000Z');

/** The pricing rows as bundle-rows.sql reads them from a freshly migrated database. */
export const seededRows: SnapshotRows = rows as SnapshotRows;

/** A pricing bundle from rows, exactly as loadPricingBundle builds one (makeBundle, then validateSnapshot). */
export function bundleFromRows(r: SnapshotRows, builtAt: Date = BUILT_AT): PricingBundle {
  const bundle = makeBundle(structuredClone(r), builtAt);
  validateSnapshot(bundle.snapshot);
  return bundle;
}

/** The bundle a new database prices with. */
export const seededBundle: PricingBundle = bundleFromRows(seededRows);
