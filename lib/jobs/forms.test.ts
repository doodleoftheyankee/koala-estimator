import { describe, expect, it } from 'vitest';
import { parseWith } from '@/lib/admin/forms';
import {
  actualCosts,
  actualForm,
  actualValues,
  canMarkLost,
  crewFieldName,
  excludeForm,
  markLostForm,
  membershipChanges,
  parseMembershipForm,
  scheduleForm,
  statusForm,
  valuesChanged,
} from './forms';

const JOB = '11111111-1111-4111-8111-111111111111';
const AREA = '22222222-2222-4222-8222-222222222221';
const CREW_A = 'c2000000-0000-0000-0000-000000000001';
const CREW_B = 'c2000000-0000-0000-0000-000000000002';

describe('scheduleForm', () => {
  it('turns blanks into nulls', () => {
    expect(parseWith(scheduleForm, { id: JOB, crew_id: '', scheduled_start: '', scheduled_days: '' })).toEqual({
      ok: true,
      data: { id: JOB, crew_id: null, scheduled_start: null, scheduled_days: null },
    });
  });
  it('checks dates, crews and days', () => {
    expect(parseWith(scheduleForm, { id: JOB, crew_id: CREW_A, scheduled_start: '2026-10-21', scheduled_days: '1.5' })).toMatchObject({
      ok: true,
      data: { crew_id: CREW_A, scheduled_start: '2026-10-21', scheduled_days: 1.5 },
    });
    expect(parseWith(scheduleForm, { id: JOB, scheduled_start: '2026-02-30' })).toMatchObject({ ok: false, error: expect.stringContaining('real date') });
    expect(parseWith(scheduleForm, { id: JOB, scheduled_days: '0' })).toMatchObject({ ok: false });
    expect(parseWith(scheduleForm, { id: JOB, crew_id: 'crew a' })).toMatchObject({ ok: false, error: expect.stringContaining('Crew') });
  });
});

describe('statusForm', () => {
  it('reads the status and the cancel confirmation', () => {
    expect(parseWith(statusForm, { id: JOB, status: 'cancelled', confirm: 'true' })).toMatchObject({ ok: true, data: { confirm: true } });
    expect(parseWith(statusForm, { id: JOB, status: 'completed' })).toMatchObject({ ok: true, data: { confirm: false } });
    expect(parseWith(statusForm, { id: JOB, status: 'done' })).toMatchObject({ ok: false });
  });
});

describe('actualForm', () => {
  const base = { job_id: JOB, id: '', area_id: AREA, product: 'cellulose', material_unit: 'bag' };
  it('parses an area row and splits values from costs', () => {
    const r = parseWith(actualForm, { ...base, material_qty: '1,200', hours: '15.5', material_cost: '$812.50', notes: ' extra ' });
    if (!r.ok) throw new Error(r.error);
    expect(actualValues(r.data)).toEqual({
      actual_material_qty: 1200,
      actual_material_unit: 'bag',
      actual_hours: 15.5,
      actual_crew_size: null,
      actual_drive_minutes: null,
      actual_days: null,
      notes: 'extra',
    });
    expect(actualCosts(r.data)).toEqual({ actual_material_cost: 812.5, actual_labor_cost: null, actual_other_cost: null });
  });
  it('keeps job-row fields on the job row only', () => {
    const r = parseWith(actualForm, { job_id: JOB, area_id: '', product: '', material_qty: '3', hours: '4', crew_size: '2', drive_minutes: '25', days: '1' });
    if (!r.ok) throw new Error(r.error);
    expect(actualValues(r.data)).toMatchObject({ actual_material_qty: null, actual_hours: null, actual_crew_size: 2, actual_drive_minutes: 25, actual_days: 1 });
    const area = parseWith(actualForm, { ...base, material_qty: '', crew_size: '2' });
    if (!area.ok) throw new Error(area.error);
    expect(actualValues(area.data)).toMatchObject({ actual_material_unit: null, actual_crew_size: null });
  });
  it('rejects half-keyed rows and bad numbers', () => {
    expect(parseWith(actualForm, { ...base, product: '' })).toMatchObject({ ok: false });
    expect(parseWith(actualForm, { ...base, hours: '-2' })).toMatchObject({ ok: false, error: expect.stringContaining('Person-hours') });
    expect(parseWith(actualForm, { job_id: JOB, crew_size: '2.5' })).toMatchObject({ ok: false, error: expect.stringContaining('whole number') });
    expect(parseWith(actualForm, { ...base, product: 'gold' })).toMatchObject({ ok: false });
  });
});

describe('valuesChanged', () => {
  it('compares numbers from Postgres strings and trims text', () => {
    const stored = { actual_hours: '15.500', actual_material_qty: '75.0000', notes: 'extra ', actual_days: null };
    expect(valuesChanged({ actual_hours: 15.5, actual_material_qty: 75, notes: 'extra', actual_days: null }, stored)).toBe(false);
    expect(valuesChanged({ actual_hours: 16 }, stored)).toBe(true);
    expect(valuesChanged({ notes: null }, { notes: '' })).toBe(false);
    expect(valuesChanged({ actual_days: 1 }, stored)).toBe(true);
    expect(valuesChanged({ actual_material_unit: 'bag' }, { actual_material_unit: 'bag' })).toBe(false);
  });
});

describe('excludeForm', () => {
  it('needs a reason to exclude, not to include', () => {
    const id = '44444444-4444-4444-8444-444444444441';
    expect(parseWith(excludeForm, { job_id: JOB, id, exclude: 'true', reason: '' })).toMatchObject({ ok: false, error: expect.stringContaining('reason') });
    expect(parseWith(excludeForm, { job_id: JOB, id, exclude: 'true', reason: 'callback' })).toMatchObject({ ok: true, data: { exclude: true, reason: 'callback' } });
    expect(parseWith(excludeForm, { job_id: JOB, id, exclude: 'false' })).toMatchObject({ ok: true, data: { exclude: false, reason: null } });
  });
});

describe('mark lost', () => {
  it('only from open statuses, with a reason', () => {
    expect(['draft', 'ready', 'sent', 'viewed', 'expired'].every(canMarkLost)).toBe(true);
    expect(['signed', 'lost', 'void'].some(canMarkLost)).toBe(false);
    expect(parseWith(markLostForm, { id: JOB, reason: '  ' })).toMatchObject({ ok: false, error: 'Reason is required' });
    expect(parseWith(markLostForm, { id: JOB, reason: 'Went with a competitor' })).toMatchObject({ ok: true });
  });
});

describe('crew membership', () => {
  const PERSON = '00000000-0000-0000-0000-0000000000b4';
  it('reads one choice per crew on the form', () => {
    const r = parseMembershipForm({ profile_id: PERSON, [crewFieldName(CREW_A)]: 'lead', [crewFieldName(CREW_B)]: 'none' }, [CREW_A, CREW_B]);
    expect(r).toEqual({ ok: true, profileId: PERSON, memberships: [{ crewId: CREW_A, isLead: true }] });
    expect(parseMembershipForm({ profile_id: PERSON, [crewFieldName(CREW_A)]: 'member' }, [CREW_A, CREW_B])).toMatchObject({
      ok: true,
      memberships: [{ crewId: CREW_A, isLead: false }],
    });
    expect(parseMembershipForm({ profile_id: PERSON, [crewFieldName(CREW_A)]: 'boss' }, [CREW_A])).toMatchObject({ ok: false });
    expect(parseMembershipForm({ profile_id: 'nope' }, [CREW_A])).toMatchObject({ ok: false });
  });
  it('writes only the differences, for crews on the form', () => {
    const existing = [
      { crewId: CREW_A, isLead: false },
      { crewId: CREW_B, isLead: true },
      { crewId: 'other', isLead: false },
    ];
    expect(membershipChanges(existing, [{ crewId: CREW_A, isLead: true }], [CREW_A, CREW_B])).toEqual({ upserts: [{ crewId: CREW_A, isLead: true }], deletes: [CREW_B] });
    expect(membershipChanges(existing, [{ crewId: CREW_A, isLead: false }, { crewId: CREW_B, isLead: true }], [CREW_A, CREW_B])).toEqual({ upserts: [], deletes: [] });
    expect(membershipChanges([], [{ crewId: CREW_A, isLead: false }, { crewId: 'not-on-form', isLead: false }], [CREW_A])).toEqual({ upserts: [{ crewId: CREW_A, isLead: false }], deletes: [] });
  });
});
