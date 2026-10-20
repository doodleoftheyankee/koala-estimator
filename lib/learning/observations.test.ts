import { describe, expect, it } from 'vitest';
import { lineKey, priceEstimate, type PricedOption } from '@/lib/pricing';
import { area, coefficients, estimate, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { observationsFromJob, winObservationFromQuote, type ActualRow, type JobForLearning, type QuoteOutcomeRow } from './observations';
import type { QuoteSnapshotForLearning } from './types';

// 1,000 sq ft attic, difficult access, old insulation removed. Better = removal + cellulose + air sealing.
const input = estimate({
  areas: [area({ removalNeeded: true, accessLevel: 'difficult' })],
  driveMinutesOneWay: 25,
  lineOverrides: { [lineKey('a1', 'cellulose', 'material')]: { qty: 95, reason: 'Uneven joists' } },
});
const priced = priceEstimate(input, snapshot, coefficients);
const frozenInput: NonNullable<QuoteSnapshotForLearning['input']> = {
  areas: [{ id: 'a1', name: 'Main attic', jobType: 'attic', accessLevel: 'difficult', sqft: 1000 }],
  driveMinutesOneWay: 25,
};

const row = (patch: Partial<ActualRow>): ActualRow => ({
  areaId: 'a1',
  product: null,
  actualMaterialQty: null,
  actualHours: null,
  actualDriveMinutes: null,
  ...patch,
});

const job = (patch: Partial<JobForLearning> = {}): JobForLearning => ({
  jobId: 'job-1',
  completedAt: '2026-10-01T16:00:00Z',
  signedTier: 'better',
  snapshot: { options: priced.options, input: frozenInput },
  areasFallback: [],
  actuals: [
    row({ product: 'cellulose', actualMaterialQty: 92, actualHours: 20 }),
    row({ product: 'air_sealing', actualMaterialQty: 900, actualHours: 7.5 }),
    row({ product: 'removal', actualHours: 31 }),
    row({ areaId: null, actualDriveMinutes: 32 }),
  ],
  driveMinutesEstFallback: null,
  ...patch,
});

describe('observationsFromJob', () => {
  it('builds one observation per area x product with a priced line and an actual', () => {
    const { observations, drive } = observationsFromJob(job());
    expect(observations).toEqual([
      {
        jobId: 'job-1',
        areaId: 'a1',
        completedAt: '2026-10-01T16:00:00Z',
        product: 'cellulose',
        jobType: 'attic',
        accessLevel: 'difficult',
        sqft: 1000,
        designQty: 83.33,
        modelQty: 90,
        estQty: 95, // the estimator's override, not the model's
        modelHours: 18.88,
        estHours: 18.88,
        actualQty: 92,
        actualHours: 20,
      },
      {
        jobId: 'job-1',
        areaId: 'a1',
        completedAt: '2026-10-01T16:00:00Z',
        product: 'air_sealing',
        jobType: 'attic',
        accessLevel: 'difficult',
        sqft: 1000,
        designQty: 1000,
        modelQty: 1000,
        estQty: 1000,
        modelHours: 8.6,
        estHours: 8.6,
        actualQty: 900,
        actualHours: 7.5,
      },
      {
        jobId: 'job-1',
        areaId: 'a1',
        completedAt: '2026-10-01T16:00:00Z',
        product: 'removal',
        jobType: 'attic',
        accessLevel: 'difficult',
        sqft: 1000,
        designQty: null, // removal has no material line
        modelQty: null,
        estQty: null,
        modelHours: 28,
        estHours: 28,
        actualQty: null,
        actualHours: 31,
      },
    ]);
    expect(drive).toEqual({ jobId: 'job-1', completedAt: '2026-10-01T16:00:00Z', estMinutes: 25, actualMinutes: 32 });
  });

  it('uses the signed tier only', () => {
    const { observations } = observationsFromJob(job({ signedTier: 'good' }));
    // Good is blown fiberglass: the cellulose and air-sealing actuals have no line there.
    expect(observations.map((o) => o.product)).toEqual(['removal']);
  });

  it('yields no area observations when the signed tier is missing from the snapshot, but still the drive', () => {
    const r = observationsFromJob(job({ snapshot: { options: priced.options.filter((o) => o.tier !== 'better'), input: frozenInput } }));
    expect(r.observations).toEqual([]);
    expect(r.drive).not.toBeNull();
  });

  it('skips rows without an area or product, for unknown areas, or without a matching line', () => {
    const { observations } = observationsFromJob(
      job({
        actuals: [
          row({ areaId: null, product: 'cellulose', actualHours: 5 }),
          row({ product: null, actualHours: 5 }),
          row({ areaId: 'nope', product: 'cellulose', actualHours: 5 }),
          row({ product: 'ocsf', actualHours: 5 }),
        ],
      }),
    );
    expect(observations).toEqual([]);
  });

  it('keeps an observation that has only a material line or only an hours line', () => {
    const better = priced.options.find((o) => o.tier === 'better')!;
    const onlyMaterial: PricedOption = { ...better, lines: better.lines.filter((l) => !(l.product === 'cellulose' && l.kind === 'labor')) };
    const r1 = observationsFromJob(job({ snapshot: { options: [onlyMaterial], input: frozenInput } }));
    expect(r1.observations[0]).toMatchObject({ product: 'cellulose', modelQty: 90, modelHours: null, estHours: null });
    const onlyHours: PricedOption = { ...better, lines: better.lines.filter((l) => !(l.product === 'cellulose' && l.kind === 'material')) };
    const r2 = observationsFromJob(job({ snapshot: { options: [onlyHours], input: frozenInput } }));
    expect(r2.observations[0]).toMatchObject({ product: 'cellulose', designQty: null, modelQty: null, estQty: null, modelHours: 18.88 });
  });

  it('falls back to estimate_areas and estimates.drive_minutes_est for snapshots that predate input', () => {
    const r = observationsFromJob(
      job({
        snapshot: { options: priced.options },
        areasFallback: [{ id: 'a1', name: 'Attic', jobType: 'attic', accessLevel: 'moderate', sqft: 980 }],
        driveMinutesEstFallback: 18,
      }),
    );
    expect(r.observations).toHaveLength(3);
    expect(r.observations[0]).toMatchObject({ accessLevel: 'moderate', sqft: 980 });
    expect(r.drive).toMatchObject({ estMinutes: 18, actualMinutes: 32 });
  });

  it('prefers the frozen input over the fallback areas', () => {
    const r = observationsFromJob(job({ areasFallback: [{ id: 'a1', name: 'Attic', jobType: 'walls', accessLevel: 'easy', sqft: 1 }] }));
    expect(r.observations[0]).toMatchObject({ jobType: 'attic', accessLevel: 'difficult', sqft: 1000 });
  });

  it('uses the fallback drive estimate when the frozen input has none', () => {
    const r = observationsFromJob(job({ snapshot: { options: priced.options, input: { ...frozenInput, driveMinutesOneWay: null } }, driveMinutesEstFallback: 40 }));
    expect(r.drive?.estMinutes).toBe(40);
  });

  it('has no drive observation without a positive actual or a positive estimate', () => {
    const noActual = job({ actuals: [row({ areaId: null, actualDriveMinutes: 0 }), row({ areaId: null, actualDriveMinutes: null })] });
    expect(observationsFromJob(noActual).drive).toBeNull();
    const zeroEst = job({ snapshot: { options: priced.options, input: { ...frozenInput, driveMinutesOneWay: 0 } } });
    expect(observationsFromJob(zeroEst).drive).toBeNull();
    const noEst = job({ snapshot: { options: priced.options }, driveMinutesEstFallback: null, areasFallback: [] });
    expect(observationsFromJob(noEst).drive).toBeNull();
  });

  it('turns non-finite numbers into nulls', () => {
    const { observations, drive } = observationsFromJob(
      job({ actuals: [row({ product: 'removal', actualHours: NaN, actualMaterialQty: Infinity }), row({ areaId: null, actualDriveMinutes: NaN })] }),
    );
    expect(observations[0]).toMatchObject({ actualHours: null, actualQty: null });
    expect(drive).toBeNull();
  });
});

describe('winObservationFromQuote', () => {
  const options = priceEstimate(estimate(), snapshot, coefficients).options; // good 5420, better 4815, best 4815
  const quote = (patch: Partial<QuoteOutcomeRow> = {}, snap: Partial<QuoteOutcomeRow['snapshot']> = {}): QuoteOutcomeRow => ({
    estimateId: 'est-1',
    won: true,
    decidedAt: '2026-10-02T15:00:00Z',
    source: 'Referral',
    signedTier: 'good',
    ...patch,
    snapshot: {
      document: { recommendedTier: 'good' },
      options,
      input: {
        areas: [
          { id: 'a1', name: 'Attic', jobType: 'attic', accessLevel: 'easy', sqft: 1000 },
          { id: 'a2', name: 'Crawl', jobType: 'crawlspace', accessLevel: 'easy', sqft: 1400 },
          { id: 'a3', name: 'Rim', jobType: 'rim_joist', accessLevel: 'easy', sqft: 1400 },
        ],
        driveMinutesOneWay: 20,
      },
      ...snap,
    },
  });
  const good = options.find((o) => o.tier === 'good')!;
  const better = options.find((o) => o.tier === 'better')!;

  it('uses the recommended option, the largest area and the total size', () => {
    expect(winObservationFromQuote(quote())).toEqual({
      estimateId: 'est-1',
      won: true,
      decidedAt: '2026-10-02T15:00:00Z',
      markup: good.price / good.loadedCost,
      price: good.price,
      jobType: 'crawlspace', // first of the largest areas
      source: 'Referral',
      sqft: 3800,
    });
  });

  it("falls back to 'better', then to the first option", () => {
    expect(winObservationFromQuote(quote({}, { document: { recommendedTier: null } }))!.price).toBe(better.price);
    expect(winObservationFromQuote(quote({}, { document: {} }))!.price).toBe(better.price);
    expect(winObservationFromQuote(quote({}, { document: undefined }))!.price).toBe(better.price);
    const noBetter = options.filter((o) => o.tier !== 'better');
    expect(winObservationFromQuote(quote({}, { document: { recommendedTier: 'better' }, options: noBetter }))!.price).toBe(good.price);
  });

  it('defaults the job type and size when the snapshot predates input', () => {
    const r = winObservationFromQuote(quote({ won: false, source: null }, { input: undefined }))!;
    expect(r).toMatchObject({ jobType: 'unknown', sqft: 0, won: false, source: null });
  });

  it('is null without options or without a usable cost and price', () => {
    expect(winObservationFromQuote(quote({}, { options: undefined }))).toBeNull();
    expect(winObservationFromQuote(quote({}, { options: [] }))).toBeNull();
    expect(winObservationFromQuote(quote({}, { options: [{ ...good, loadedCost: 0 }] }))).toBeNull();
    expect(winObservationFromQuote(quote({}, { options: [{ ...good, loadedCost: NaN }] }))).toBeNull();
    expect(winObservationFromQuote(quote({}, { options: [{ ...good, price: 0 }] }))).toBeNull();
  });
});
