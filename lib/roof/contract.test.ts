// Roof Takeoff's own answers, read the way this app reads them. The files in
// __fixtures__/roof-takeoff are exact GET /api/takeoff bodies from the Roof Takeoff repo's mock
// server (npm run mock there: its seven made-up houses, the cross gable again at an 18-inch
// overhang, and the Cape looked up by a spot on the map). With Roof Takeoff's own face choices,
// the attic floor, roof deck and wall run here must be the ones it sent (attic.floorM2, deckM2,
// wallRunM): both apps use the same contract formulas.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOnSite, compactTakeoff, defaultFaces, M_PER_IN, noteLine, roofFigures, SQFT_PER_M2, FT_PER_M, takeoffSchema } from './lookup';

const dir = join(import.meta.dirname, '__fixtures__', 'roof-takeoff');
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

describe("Roof Takeoff's answers (its mock houses)", () => {
  it('has all of them', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    it(`${file}: same attic floor, roof deck and wall run as Roof Takeoff`, () => {
      const body = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const parsed = takeoffSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues?.slice(0, 3))).toBe(true);
      const r = compactTakeoff(parsed.data!);
      const a = body.attic;

      // The defaults are Roof Takeoff's: attic.excluded, the parts with no roof data kept.
      expect(r.defaultExcluded).toEqual(a.excluded);
      expect(r.unmatchedM2).toBe(a.unmatchedM2);
      expect(r.sharedWallM).toBe(a.sharedWallM);
      expect(r.segments.map((s) => s.lower)).toEqual(body.segments.map((s: { lower: boolean }) => s.lower));

      const overhangIn = Math.round(a.overhangM / M_PER_IN);
      const f = roofFigures(r, { overhangIn, ...defaultFaces(r, 'house') });
      // Roof Takeoff rounds to 0.01 m² and 0.001 m.
      expect(Math.abs(f.floorSqft / SQFT_PER_M2 - a.floorM2)).toBeLessThan(0.02);
      if (a.deckM2 === null) expect(f.deckSqft).toBeNull();
      else expect(Math.abs(f.deckSqft! / SQFT_PER_M2 - a.deckM2)).toBeLessThan(0.02);
      expect(Math.abs(f.wallRunFt! / FT_PER_M - a.wallRunM)).toBeLessThan(0.002);

      // Every kind of area can show it and write its prep note.
      for (const job of ['attic', 'crawlspace', 'garage', 'walls'] as const) {
        const g = roofFigures(r, { overhangIn, ...defaultFaces(r, job === 'garage' ? 'garage' : 'house') });
        expect(checkOnSite(r, g, job, false).length).toBeGreaterThanOrEqual(r.warnings.length);
        expect(noteLine(r, g, defaultFaces(r, job === 'garage' ? 'garage' : 'house'), job)).toMatch(/^• Satellite \(Google imagery [A-Z][a-z]{2} \d{4}\): /);
      }
    });
  }

  it('a lookup by a spot on the map comes back as a pin with no address', () => {
    const r = compactTakeoff(takeoffSchema.parse(JSON.parse(readFileSync(join(dir, '7-cape-pin.json'), 'utf8'))));
    expect(r.address).toBeNull();
    expect(r.precision).toBe('PIN');
  });
});
