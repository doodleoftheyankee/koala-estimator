import { describe, expect, it } from 'vitest';
import { compareActuals, costTotals, signedOption, type OfficeActual } from './office';

const ATTIC = '22222222-2222-4222-8222-222222222221';
const GARAGE = '22222222-2222-4222-8222-222222222222';
const areas = [
  { id: ATTIC, name: 'Main attic' },
  { id: GARAGE, name: 'Garage' },
];

const snapshot = {
  document: {
    options: [
      { tier: 'good', label: 'Blown Fiberglass to Code', price: 4795 },
      { tier: 'better', label: 'Air Seal + Blown Cellulose', price: 6400 },
    ],
  },
  options: [
    { tier: 'good', label: 'Good', price: 4795, crewDays: 1, lines: [{ areaId: ATTIC, kind: 'material', product: 'fiberglass_blown', qty: 40, unit: 'bag' }] },
    {
      tier: 'better',
      label: 'Better (engine label)',
      price: 6400,
      crewDays: 1.5,
      lines: [
        { areaId: ATTIC, kind: 'material', product: 'cellulose', qty: 70, unit: 'bag', hours: null },
        { areaId: ATTIC, kind: 'labor', product: 'cellulose', qty: 14, unit: 'hour', hours: 14 },
        { areaId: ATTIC, kind: 'labor', product: 'air_sealing', qty: 6, unit: 'hour', hours: 6 },
        { areaId: GARAGE, kind: 'removal', product: 'removal', qty: 5, unit: 'hour', hours: 5 },
        { areaId: null, kind: 'drive', product: null, qty: 2, unit: 'each', hours: 3 },
        { areaId: null, kind: 'disposal', product: 'removal', qty: 400, unit: 'sqft' },
        { areaId: GARAGE, kind: 'misc', product: 'batts', qty: 1 },
      ],
    },
  ],
  input: { areas: [], driveMinutesOneWay: 25 },
};

function actual(over: Partial<OfficeActual> & Pick<OfficeActual, 'id'>): OfficeActual {
  return {
    areaId: ATTIC,
    product: 'cellulose',
    materialQty: null,
    materialUnit: null,
    hours: null,
    crewSize: null,
    driveMinutes: null,
    days: null,
    materialCost: null,
    laborCost: null,
    otherCost: null,
    notes: null,
    enteredBy: 'Crew Lead',
    enteredAt: '2026-10-20T20:00:00Z',
    verifiedBy: null,
    verifiedAt: null,
    excluded: false,
    excludeReason: null,
    ...over,
  };
}

describe('signedOption', () => {
  it('reads the label and price the customer saw', () => {
    expect(signedOption(snapshot, 'better', 6400)).toEqual({ tier: 'better', label: 'Air Seal + Blown Cellulose', price: 6400 });
    expect(signedOption(snapshot, 'better', null)?.price).toBe(6400);
  });
  it('falls back to the priced option, then to the tier name', () => {
    expect(signedOption({ options: snapshot.options }, 'good', null)).toEqual({ tier: 'good', label: 'Good', price: 4795 });
    expect(signedOption({}, 'best', 9000)).toEqual({ tier: 'best', label: 'Best', price: 9000 });
    expect(signedOption('garbage', 'best', null)).toEqual({ tier: 'best', label: 'Best', price: null });
    expect(signedOption(snapshot, null, 100)).toBeNull();
  });
});

describe('compareActuals', () => {
  const actuals = [
    actual({ id: 'a1', materialQty: 75, materialUnit: 'bag', hours: 15.5, materialCost: 812.5, laborCost: 640 }),
    actual({ id: 'a2', areaId: null, product: null, driveMinutes: 28, days: 2, crewSize: 2, otherCost: 120 }),
    actual({ id: 'a3', product: 'ocsf', hours: 2 }),
    actual({ id: 'a4', areaId: GARAGE, product: 'removal', hours: 7 }),
  ];

  it('compares the signed option per area x product', () => {
    const { rows, job } = compareActuals({ snapshot, signedTier: 'better', areas, actuals, driveMinutesEstFallback: null });
    // Drive, disposal and misc lines are not area scope.
    expect(rows.map((r) => `${r.areaName}|${r.product}`)).toEqual(['Main attic|cellulose', 'Main attic|air_sealing', 'Main attic|ocsf', 'Garage|removal']);
    const cell = rows[0]!;
    expect(cell).toMatchObject({ unit: 'bag', hasMaterial: true, estQty: 70, actualQty: 75, estHours: 14, actualHours: 15.5, inScope: true });
    expect(cell.qtyVariance).toBeCloseTo(5 / 70);
    expect(cell.hoursVariance).toBeCloseTo(1.5 / 14);
    expect(cell.actual?.id).toBe('a1');
    expect(rows[1]).toMatchObject({ hasMaterial: false, estHours: 6, actualHours: null, hoursVariance: null, actual: null });
    expect(rows[2]).toMatchObject({ inScope: false, estHours: null, actualHours: 2 });
    expect(rows[3]).toMatchObject({ label: 'Removal of old insulation', estHours: 5, actualHours: 7 });
    expect(rows[3]!.hoursVariance).toBeCloseTo(0.4);
    expect(job).toMatchObject({ estDriveMinutes: 25, actualDriveMinutes: 28, estDays: 1.5, actualDays: 2, actualCrewSize: 2 });
    expect(job.driveVariance).toBeCloseTo(0.12);
    expect(job.actual?.id).toBe('a2');
  });
  it('falls back to the estimate drive time and copes with old or missing snapshots', () => {
    const { rows, job } = compareActuals({ snapshot: { options: [] }, signedTier: 'better', areas, actuals: [actuals[0]!], driveMinutesEstFallback: 30 });
    expect(job.estDriveMinutes).toBe(30);
    expect(job.estDays).toBeNull();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ inScope: false, hasMaterial: true, unit: 'bag', estQty: null, qtyVariance: null });
    const empty = compareActuals({ snapshot: null, signedTier: null, areas: [], actuals: [actual({ id: 'x', areaId: 'gone', hours: 1 })], driveMinutesEstFallback: null });
    expect(empty.rows[0]).toMatchObject({ areaName: 'Unknown area' });
    expect(empty.job).toMatchObject({ estDriveMinutes: null, driveVariance: null, actual: null });
  });
  it('adds up repeated lines', () => {
    const snap = {
      options: [
        {
          tier: 'good',
          lines: [
            { areaId: ATTIC, kind: 'labor', product: 'batts', hours: 1.1 },
            { areaId: ATTIC, kind: 'labor', product: 'batts', hours: 2.2 },
            { areaId: ATTIC, kind: 'material', product: 'batts', qty: 10, unit: 'nonsense' },
            { areaId: ATTIC, kind: 'material', product: 'batts', qty: 5, unit: 'sqft' },
            { areaId: ATTIC, kind: 'labor', product: 'unobtainium', hours: 9 },
          ],
        },
      ],
    };
    const { rows } = compareActuals({ snapshot: snap, signedTier: 'good', areas, actuals: [], driveMinutesEstFallback: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ estHours: 3.3, estQty: 15, unit: 'sqft' });
  });
});

describe('costTotals', () => {
  it('sums what was entered', () => {
    expect(
      costTotals([actual({ id: 'a', materialCost: 812.5, laborCost: 640 }), actual({ id: 'b', otherCost: 120.1 }), actual({ id: 'c', materialCost: 0.2 })]),
    ).toEqual({ material: 812.7, labor: 640, other: 120.1, total: 1572.8 });
  });
  it('is null when nothing was entered', () => {
    expect(costTotals([actual({ id: 'a' })])).toEqual({ material: null, labor: null, other: null, total: null });
  });
});
