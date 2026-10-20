import { describe, expect, it } from 'vitest';
import {
  actualDbRowSchema,
  actualsBodySchema,
  crewJobsResponseSchema,
  crewViewRowSchema,
  groupViewRows,
  mapsUrl,
  naturalKey,
  telUrl,
  toDbActualRow,
  toServerActual,
  type ActualsRow,
} from './crew';

const JOB = '11111111-1111-4111-8111-111111111111';
const A1 = '22222222-2222-4222-8222-222222222221';
const A2 = '22222222-2222-4222-8222-222222222222';

function viewRow(over: Record<string, unknown> = {}) {
  return {
    job_id: JOB,
    status: 'scheduled',
    scheduled_start: '2026-10-21',
    scheduled_days: '1.5',
    started_at: null,
    completed_at: null,
    street: '9 Elkton Rd',
    city: 'Newark',
    zip: '19711',
    lat: '39.68',
    lng: -75.75,
    first_name: 'Jo',
    last_name: 'Ruiz',
    phone: '+1 (302) 555-0111',
    area_id: A1,
    area_name: 'Main attic',
    job_type: 'attic',
    sqft: '1200.0',
    access_level: 'difficult',
    removal_needed: false,
    prep_notes: '',
    hazards: null,
    hazard_disposition: null,
    area_sort: 0,
    signed_tier: 'better',
    scope: [
      { product: 'cellulose', kind: 'material', description: 'Blown cellulose', qty: '70', unit: 'bag', hours: null },
      { product: 'cellulose', kind: 'labor', description: 'Install cellulose', qty: 14, unit: 'hour', hours: 14 },
      { product: null, kind: 'labor', description: 'Mystery line', qty: 1, unit: 'hour', hours: 1 },
    ],
    ...over,
  };
}

describe('crewViewRowSchema', () => {
  it('coerces numeric strings and blanks', () => {
    const r = crewViewRowSchema.parse(viewRow());
    expect(r.sqft).toBe(1200);
    expect(r.scheduled_days).toBe(1.5);
    expect(r.lat).toBe(39.68);
    expect(r.prep_notes).toBeNull();
    expect(r.hazards).toEqual([]);
    expect(r.scope).toHaveLength(2); // the line without a product is dropped
    expect(r.scope[0]).toMatchObject({ product: 'cellulose', qty: 70, unit: 'bag', hours: null });
  });
  it('treats a missing scope as empty and rejects garbage numbers', () => {
    expect(crewViewRowSchema.parse(viewRow({ scope: null })).scope).toEqual([]);
    expect(crewViewRowSchema.safeParse(viewRow({ sqft: 'lots' })).success).toBe(false);
  });
});

describe('groupViewRows', () => {
  it('folds area rows into jobs with areas in estimate order', () => {
    const rows = [
      viewRow({ area_id: A2, area_name: 'Garage', area_sort: 2, scope: [] }),
      viewRow(),
      viewRow(), // duplicate area row is ignored
      viewRow({ job_id: '33333333-3333-4333-8333-333333333333', area_id: A1, first_name: 'Sam', last_name: '' }),
    ].map((r) => crewViewRowSchema.parse(r));
    const jobs = groupViewRows(rows);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.areas.map((a) => a.name)).toEqual(['Main attic', 'Garage']);
    expect(jobs[0]!.customer).toEqual({ name: 'Jo Ruiz', phone: '+1 (302) 555-0111' });
    expect(jobs[0]!.address).toEqual({ street: '9 Elkton Rd', city: 'Newark', zip: '19711', lat: 39.68, lng: -75.75 });
    expect(jobs[1]!.customer.name).toBe('Sam');
  });
  it('produces jobs the client-side schema accepts', () => {
    const [job] = groupViewRows([crewViewRowSchema.parse(viewRow())]);
    const body = { jobs: [{ ...job, actuals: [], verified: false }], fetchedAt: '2026-10-20T12:00:00Z' };
    expect(crewJobsResponseSchema.safeParse(body).success).toBe(true);
  });
});

describe('actuals rows', () => {
  const row = (over: Partial<ActualsRow> = {}): ActualsRow => ({
    id: '44444444-4444-4444-8444-444444444441',
    areaId: A1,
    product: 'cellulose',
    materialQty: 75,
    materialUnit: 'bag',
    hours: 15.5,
    crewSize: null,
    driveMinutes: null,
    days: null,
    notes: ' two extra bags ',
    ...over,
  });
  const jobRow = row({ id: '44444444-4444-4444-8444-444444444442', areaId: null, product: null, materialQty: null, materialUnit: null, hours: null, crewSize: 2, driveMinutes: 28, days: 1, notes: '' });

  it('accepts a job body and trims notes', () => {
    const b = actualsBodySchema.parse({ mutationId: '55555555-5555-4555-8555-555555555555', jobId: JOB, rows: [row(), jobRow] });
    expect(b.rows[0]!.notes).toBe('two extra bags');
  });
  it('rejects half-keyed rows, duplicate keys or ids, and out-of-range values', () => {
    const body = (rows: ActualsRow[]) => ({ mutationId: '55555555-5555-4555-8555-555555555555', jobId: JOB, rows });
    expect(actualsBodySchema.safeParse(body([row({ product: null })])).success).toBe(false);
    expect(actualsBodySchema.safeParse(body([row(), row({ id: '44444444-4444-4444-8444-444444444449' })])).success).toBe(false);
    expect(actualsBodySchema.safeParse(body([row(), row({ product: 'air_sealing' })])).success).toBe(false);
    expect(actualsBodySchema.safeParse(body([row({ hours: -1 })])).success).toBe(false);
    expect(actualsBodySchema.safeParse(body([{ ...jobRow, crewSize: 2.5 }])).success).toBe(false);
  });
  it('maps to job_actuals columns without costs', () => {
    const db = toDbActualRow(row({ notes: '' }));
    expect(db).toEqual({
      id: '44444444-4444-4444-8444-444444444441',
      area_id: A1,
      product: 'cellulose',
      actual_material_qty: 75,
      actual_material_unit: 'bag',
      actual_hours: 15.5,
      actual_crew_size: null,
      actual_drive_minutes: null,
      actual_days: null,
      notes: null,
    });
    expect(Object.keys(db).some((k) => /cost|verified|exclude/.test(k))).toBe(false);
    expect(toDbActualRow(row({ materialQty: null })).actual_material_unit).toBeNull();
  });
  it('reads server rows (numeric strings included)', () => {
    const r = actualDbRowSchema.parse({
      id: '44444444-4444-4444-8444-444444444441',
      job_id: JOB,
      area_id: A1,
      product: 'cellulose',
      actual_material_qty: '75.0000',
      actual_material_unit: 'bag',
      actual_hours: '15.500',
      actual_crew_size: null,
      actual_drive_minutes: null,
      actual_days: null,
      notes: null,
      entered_at: '2026-10-20T20:00:00Z',
      verified_at: null,
    });
    expect(toServerActual(r)).toMatchObject({ materialQty: 75, hours: 15.5, areaId: A1, enteredAt: '2026-10-20T20:00:00Z' });
  });
  it('keys rows like the database unique index', () => {
    expect(naturalKey(A1, 'cellulose')).toBe(`${A1}|cellulose`);
    expect(naturalKey(null, null)).toBe('job');
    expect(naturalKey(A1, null)).toBe('job');
  });
});

describe('links', () => {
  it('prefers coordinates for maps', () => {
    expect(mapsUrl({ street: '9 Elkton Rd', city: 'Newark', zip: '19711', lat: 39.68, lng: -75.75 })).toBe(
      'https://www.google.com/maps/search/?api=1&query=39.68%2C-75.75',
    );
    expect(mapsUrl({ street: '9 Elkton Rd', city: 'Newark', zip: '19711', lat: null, lng: null })).toBe(
      'https://www.google.com/maps/search/?api=1&query=9%20Elkton%20Rd%2C%20Newark%2019711',
    );
  });
  it('builds dialable phone links', () => {
    expect(telUrl('+1 (302) 555-0111')).toBe('tel:+13025550111');
    expect(telUrl('302-555-0111')).toBe('tel:3025550111');
    expect(telUrl('n/a')).toBeNull();
    expect(telUrl(null)).toBeNull();
  });
});
