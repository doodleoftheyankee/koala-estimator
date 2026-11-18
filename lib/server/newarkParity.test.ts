// Newark parity: the multi-location conversion must not move the pilot store's prices by a cent.
//
// 1. Golden (always runs): the pilot store's seeded pricing rows, captured from the database before
//    the conversion (__fixtures__/newark-seed-rows.json), must still build the same bundle hash and
//    the same price on every option of a fixed grid of estimates as they did before the conversion
//    (__fixtures__/newark-golden-prices.json, recorded on main before any multi-location change).
// 2. Database (npm run test:db): the rows read from a real database just before and just after the
//    multi-location migrations (filtered to the pilot store) must be identical and price identically.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { priceEstimate } from '@/lib/pricing';
import type { AccessLevel, EstimateInput, JobType, PricingBundle } from '@/lib/pricing';
import { makeBundle, type SnapshotRows } from './snapshot';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const BUILT_AT = new Date('2026-11-18T00:00:00Z');

const readRows = (path: string): SnapshotRows => JSON.parse(readFileSync(path, 'utf8')) as SnapshotRows;

const JOB_TYPES: JobType[] = ['attic', 'walls', 'crawlspace', 'rim_joist', 'garage', 'commercial'];
const SQFT = [150, 1000, 2400];
const ACCESS: AccessLevel[] = ['easy', 'difficult'];
const CURRENT_R = [0, 19];
const REMOVAL = [false, true];
const DRIVE = [null, 25];

/** Every combination above: 288 estimates, three options each. */
function grid(): Array<{ key: string; input: EstimateInput }> {
  const out: Array<{ key: string; input: EstimateInput }> = [];
  for (const jobType of JOB_TYPES)
    for (const sqft of SQFT)
      for (const accessLevel of ACCESS)
        for (const currentR of CURRENT_R)
          for (const removalNeeded of REMOVAL)
            for (const drive of DRIVE) {
              out.push({
                key: `${jobType}/${sqft}/${accessLevel}/R${currentR}/${removalNeeded ? 'remove' : 'keep'}/${drive ?? 'blank'}`,
                input: {
                  areas: [
                    {
                      id: 'area-1',
                      name: 'Area',
                      jobType,
                      sqft,
                      currentR,
                      targetR: null,
                      existingMaterial: currentR ? 'fiberglass' : null,
                      existingDepthIn: currentR ? 6 : null,
                      depthIn: jobType === 'walls' ? 3.5 : null,
                      accessLevel,
                      removalNeeded,
                      prepNotes: null,
                    },
                  ],
                  crewId: null,
                  driveMinutesOneWay: drive,
                  overrides: {},
                },
              });
            }
  return out;
}

/** Price of every option of every grid estimate, plus each option's direct cost. */
function priceGrid(bundle: PricingBundle): Record<string, Record<string, { price: number; directCost: number }>> {
  const out: Record<string, Record<string, { price: number; directCost: number }>> = {};
  for (const { key, input } of grid()) {
    const result = priceEstimate(input, bundle.snapshot, bundle.coefficientSet);
    out[key] = Object.fromEntries(result.options.map((o) => [o.tier, { price: o.price, directCost: o.directCost }]));
  }
  return out;
}

describe('Newark parity (golden, recorded before the multi-location conversion)', () => {
  const golden = JSON.parse(readFileSync(join(FIXTURES, 'newark-golden-prices.json'), 'utf8')) as {
    hash: string;
    prices: ReturnType<typeof priceGrid>;
  };
  const bundle = makeBundle(readRows(join(FIXTURES, 'newark-seed-rows.json')), BUILT_AT);

  it('builds the same pricing bundle hash', () => {
    expect(bundle.hash).toBe(golden.hash);
  });

  it('prices every option of 288 estimates exactly as before', () => {
    const prices = priceGrid(bundle);
    expect(Object.keys(prices)).toHaveLength(288);
    expect(prices).toEqual(golden.prices);
  });
});

const before = process.env.NEWARK_PARITY_BEFORE;
const after = process.env.NEWARK_PARITY_AFTER;

describe.skipIf(!before || !after)('Newark parity (database, before vs after the migrations)', () => {
  it('reads identical pricing rows for the pilot store', () => {
    expect(readRows(after!)).toEqual(readRows(before!));
  });

  it('builds the same bundle and the same price on every option, to the cent', () => {
    const b = makeBundle(readRows(before!), BUILT_AT);
    const a = makeBundle(readRows(after!), BUILT_AT);
    expect(a.hash).toBe(b.hash);
    expect(priceGrid(a)).toEqual(priceGrid(b));
  });
});
