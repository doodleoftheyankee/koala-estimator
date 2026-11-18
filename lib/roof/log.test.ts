import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { finishLookup, reuseKeys, savedLookup, type LookupDb } from './log';
import { compactTakeoff, takeoffSchema, type RoofResult } from './lookup';

const result: RoofResult = compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '__fixtures__', 'roof-takeoff', '3-cross-gable.json'), 'utf8'))));

type Row = Record<string, unknown>;
const COLUMNS = ['id', 'location_id', 'created_at', 'created_by', 'address', 'address_key', 'pin_lat', 'pin_lng', 'status', 'result', 'error'];

/**
 * A small stand-in for the service-role client on roof_lookups: filters, order, limit and update,
 * refusing an unknown column the way PostgREST does (the whole request fails).
 */
function fakeDb(rows: Row[], { matchedColumn = true } = {}): LookupDb {
  const columns = new Set(matchedColumn ? [...COLUMNS, 'matched_key'] : COLUMNS);
  const missing = (col: string) => ({ message: `Could not find the '${col}' column of 'roof_lookups' in the schema cache`, code: 'PGRST204' });
  const query = () => {
    const tests: Array<(r: Row) => boolean> = [];
    let bad: string | null = null;
    let patch: Row | null = null;
    let take = Infinity;
    const touch = (col: string) => {
      if (!columns.has(col)) bad ??= col;
    };
    const run = () => {
      if (bad) return { data: null, error: missing(bad) };
      const hit = rows.filter((r) => tests.every((t) => t(r)));
      if (patch) {
        for (const r of hit) Object.assign(r, patch);
        return { data: null, error: null };
      }
      return { data: hit.slice(0, take), error: null };
    };
    const b = {
      select: () => b,
      eq: (c: string, v: unknown) => (touch(c), tests.push((r) => r[c] === v), b),
      gte: (c: string, v: string | number) => (touch(c), tests.push((r) => (r[c] as string | number) >= v), b),
      lte: (c: string, v: string | number) => (touch(c), tests.push((r) => (r[c] as string | number) <= v), b),
      in: (c: string, vs: unknown[]) => (touch(c), tests.push((r) => vs.includes(r[c])), b),
      order: (c: string) => (touch(c), rows.sort((x, y) => String(y[c]).localeCompare(String(x[c]))), b),
      limit: (n: number) => ((take = n), b),
      update: (v: Row) => {
        Object.keys(v).forEach(touch);
        patch = v;
        return b;
      },
      then: (ok: (v: ReturnType<typeof run>) => unknown, no?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, no),
    };
    return b;
  };
  return { from: () => query() } as unknown as LookupDb;
}

const now = () => new Date().toISOString();
const LOC = 'store-1';
const done = (over: Row): Row => ({ id: crypto.randomUUID(), location_id: LOC, created_at: now(), status: 'done', result, address: null, address_key: null, pin_lat: null, pin_lng: null, matched_key: null, ...over });

afterEach(() => vi.restoreAllMocks());

describe('reuseKeys', () => {
  it('adds the key an estimate would send when a Google-style address is typed', () => {
    expect(reuseKeys('12 Elkton Rd, Newark, DE 19711, USA')).toEqual(['12 elkton rd newark de 19711 usa', '12 elkton rd newark de 19711']);
    expect(reuseKeys('12 Elkton Rd, Newark, DE 19711-5401')).toEqual(['12 elkton rd newark de 19711-5401', '12 elkton rd newark de 19711']);
    expect(reuseKeys('12 Elkton Rd, Newark, DE, 19711')).toEqual(['12 elkton rd newark de 19711']);
    expect(reuseKeys('3 Cross Gable Ct')).toEqual(['3 cross gable ct']);
  });
});

describe('savedLookup', () => {
  it('finds a lookup of the same house written the way Google writes it', async () => {
    const earlier = done({ address: '12 Elkton Rd, Newark, DE 19711', address_key: '12 elkton rd newark de 19711' });
    const db = fakeDb([earlier]);
    expect((await savedLookup(db, LOC, '12 Elkton Rd, Newark, DE 19711, USA', null))?.id).toBe(earlier.id);
    expect((await savedLookup(db, LOC, '12 Elkton Rd, Newark, DE 19711-5401', null))?.id).toBe(earlier.id);
    expect(await savedLookup(db, LOC, '14 Elkton Rd, Newark, DE 19711', null)).toBeNull();
  });

  it('finds a page lookup by the address Google matched', async () => {
    const page = done({ address: '3 Cross Gable Ct', address_key: '3 cross gable ct', matched_key: '3 cross gable ct newark de 19711' });
    expect((await savedLookup(fakeDb([page]), LOC, '3 Cross Gable Ct, Newark, DE 19711', null))?.id).toBe(page.id);
  });

  it('still finds a lookup by what was typed when the matched-address column is not there yet', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const typed = done({ address: '3 Cross Gable Ct', address_key: '3 cross gable ct' });
    const db = fakeDb([typed], { matchedColumn: false });
    expect((await savedLookup(db, LOC, '3 cross gable  ct', null))?.id).toBe(typed.id);
    expect(await savedLookup(db, LOC, '9 Other St, Newark, DE 19711', null)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[roof] could not check for a saved lookup', expect.stringContaining('matched_key'));
  });

  it('finds a pin within about 2 m, not one farther away', async () => {
    const pin = done({ pin_lat: 39.68347, pin_lng: -75.75039 });
    const db = fakeDb([pin]);
    expect((await savedLookup(db, LOC, null, { lat: 39.683471, lng: -75.750391 }))?.id).toBe(pin.id);
    expect(await savedLookup(db, LOC, null, { lat: 39.6835, lng: -75.75039 })).toBeNull();
  });

  it("never reuses another store's lookup", async () => {
    const other = done({ location_id: 'store-2', address: '12 Elkton Rd, Newark, DE 19711', address_key: '12 elkton rd newark de 19711' });
    expect(await savedLookup(fakeDb([other]), LOC, '12 Elkton Rd, Newark, DE 19711', null)).toBeNull();
  });
});

describe('finishLookup', () => {
  it('saves the result and the key of the address Google matched', async () => {
    const row: Row = { id: 'a', status: 'pending', result: null };
    await finishLookup(fakeDb([row]), 'a', result);
    expect(row).toMatchObject({ status: 'done', result, matched_key: '3 cross gable ct newark de 19711' });
  });

  it('still saves the lookup as done when the matched-address column is not there yet', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const row: Row = { id: 'a', status: 'pending', result: null };
    const db = fakeDb([row], { matchedColumn: false });
    await finishLookup(db, 'a', result);
    expect(row).toEqual({ id: 'a', status: 'done', result });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('20261118000001'), expect.stringContaining('matched_key'));
    // And it is found again by what was typed.
    Object.assign(row, { location_id: LOC, created_at: now(), address: '3 Cross Gable Ct', address_key: '3 cross gable ct', pin_lat: null, pin_lng: null });
    expect((await savedLookup(db, LOC, '3 Cross Gable Ct', null))?.id).toBe('a');
  });

  it('adds no matched key for a tapped roof', async () => {
    const row: Row = { id: 'p', status: 'pending', result: null };
    await finishLookup(fakeDb([row]), 'p', { ...result, address: null });
    expect(row).toEqual({ id: 'p', status: 'done', result: { ...result, address: null } });
  });
});
