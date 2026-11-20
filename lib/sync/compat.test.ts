import { describe, expect, it } from 'vitest';
import { fieldsPushWouldErase, LATER_DRAFT_FIELDS, missingDraftFields, OUTDATED_APP_ERROR, type StoredEstimate } from './compat';
import { newArea, newDraft, syncableDraftSchema, type EstimateDraft } from './draft';
import { newMeasurement } from '@/lib/measure/measure';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function phase2Draft(): EstimateDraft {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), uuid, { city: 'Springfield', state: 'IL' });
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee', email: 'pat@example.com' };
  d.property = { ...d.property, street: '1 Main St', zip: '19711' };
  d.areas = [{ ...newArea('attic', uuid), sqft: 1000 }];
  d.lineOverrides = { 'a|cellulose|labor': { hours: 21.75, reason: 'Low clearance', tier: 'better' } };
  d.deviationAcks = { 'a|cellulose|labor|hours': { note: 'Low clearance, long hose run', pctDiff: 0.5 } };
  return d;
}

/** The request body's draft as a phone sends it (JSON), optionally without some keys. */
function wire(d: EstimateDraft, without: ReadonlyArray<keyof EstimateDraft> = []): unknown {
  const json = JSON.parse(JSON.stringify(d)) as Record<string, unknown>;
  for (const k of without) delete json[k];
  return json;
}

/** A Phase 1 build strips the keys it does not know, then pushes after fixing a typo. */
const phase1Push = (d: EstimateDraft) => wire({ ...d, notes: 'Fixed typo' }, ['lineOverrides', 'deviationAcks', 'measurements', 'photoReads']);

const stored = (doc: unknown, status = 'draft'): StoredEstimate => ({ status, client_doc: doc });

describe('missingDraftFields', () => {
  it('reads the JSON as received, not the parsed draft (the schema fills in {})', () => {
    const raw = phase1Push(phase2Draft());
    expect(missingDraftFields(raw)).toEqual(['lineOverrides', 'deviationAcks', 'measurements', 'photoReads']);
    const parsed = syncableDraftSchema.parse(raw);
    expect(parsed.lineOverrides).toEqual({});
    expect(missingDraftFields(parsed)).toEqual([]);
  });

  it('a field that is present but empty is not missing', () => {
    expect(missingDraftFields(wire({ ...phase2Draft(), lineOverrides: {}, deviationAcks: {} }))).toEqual([]);
    expect(missingDraftFields(wire(phase2Draft(), ['deviationAcks']))).toEqual(['deviationAcks']);
    expect(missingDraftFields(null)).toEqual([]);
    expect(missingDraftFields([])).toEqual([]);
    expect(LATER_DRAFT_FIELDS).toEqual(['lineOverrides', 'deviationAcks', 'measurements', 'photoReads', 'crewNotes']);
  });
});

describe('fieldsPushWouldErase', () => {
  it('refuses a push from an older build over an estimate that has line changes and notes', () => {
    const server = phase2Draft();
    expect(fieldsPushWouldErase(phase1Push(server), stored(server))).toEqual(['lineOverrides', 'deviationAcks']);
  });

  it('refuses a push from a build without the Measure tool over measured areas', () => {
    const server = { ...phase2Draft(), measurements: { a: newMeasurement('attic') } };
    expect(fieldsPushWouldErase(wire(server, ['measurements']), stored(server))).toEqual(['measurements']);
    expect(fieldsPushWouldErase(wire(server, ['measurements']), stored({ ...server, measurements: {} }))).toEqual([]);
  });

  it('refuses a push from a build without photo reading over areas that were read', () => {
    const read = { read: {} as never, analysisId: null, model: 'claude-opus-5-5', createdAt: '2026-11-11T12:00:00.000Z', photoIds: [], decisions: {} };
    const server = { ...phase2Draft(), photoReads: { a: read } };
    expect(fieldsPushWouldErase(wire(server, ['photoReads']), stored(server))).toEqual(['photoReads']);
  });

  it('reports only the fields that would be lost', () => {
    const server = phase2Draft();
    expect(fieldsPushWouldErase(phase1Push(server), stored({ ...server, deviationAcks: {} }))).toEqual(['lineOverrides']);
    expect(fieldsPushWouldErase(phase1Push(server), stored({ ...server, lineOverrides: {} }))).toEqual(['deviationAcks']);
    expect(fieldsPushWouldErase(wire(server, ['deviationAcks']), stored(server))).toEqual(['deviationAcks']);
  });

  it('applies a current build clearing them on purpose (present but empty)', () => {
    const server = phase2Draft();
    expect(fieldsPushWouldErase(wire({ ...server, lineOverrides: {}, deviationAcks: {} }), stored(server))).toEqual([]);
    expect(fieldsPushWouldErase(wire(server), stored(server))).toEqual([]);
  });

  it('applies an older build when there is nothing to lose', () => {
    const server = phase2Draft();
    const push = phase1Push(server);
    expect(fieldsPushWouldErase(push, null)).toEqual([]); // new estimate
    expect(fieldsPushWouldErase(push, stored({ ...server, lineOverrides: {}, deviationAcks: {} }))).toEqual([]);
    expect(fieldsPushWouldErase(push, stored(wire(server, ['lineOverrides', 'deviationAcks'])))).toEqual([]); // Phase 1 doc
    expect(fieldsPushWouldErase(push, stored(null))).toEqual([]);
    expect(fieldsPushWouldErase(push, stored({ ...server, lineOverrides: [], deviationAcks: 'x' }))).toEqual([]);
  });

  it('leaves a signed estimate to the sync function, which answers locked and erases nothing', () => {
    const server = phase2Draft();
    expect(fieldsPushWouldErase(phase1Push(server), stored(server, 'signed'))).toEqual([]);
    expect(fieldsPushWouldErase(phase1Push(server), stored(server, 'sent'))).toEqual(['lineOverrides', 'deviationAcks']);
  });

  it('tells the estimator nothing was saved and to update the app', () => {
    expect(OUTDATED_APP_ERROR).toMatch(/nothing was saved/i);
    expect(OUTDATED_APP_ERROR).toMatch(/reload the app/i);
  });
});

describe('crewNotes: the estimator\'s notes for the crew (load list)', () => {
  /** A build from before the load list: it knows every other field, but not crewNotes. */
  const preLoadListPush = (d: EstimateDraft) => wire({ ...d, notes: 'Fixed typo' }, ['crewNotes']);
  const withCrewNotes = (): EstimateDraft => ({ ...phase2Draft(), crewNotes: 'Gate code 4411. Dog in the yard.' });

  it('is a later field: an older build sends no crewNotes key', () => {
    expect(missingDraftFields(preLoadListPush(withCrewNotes()))).toEqual(['crewNotes']);
    expect(missingDraftFields(wire(withCrewNotes()))).toEqual([]);
    // The server parses such a draft with crewNotes '' (the default): the raw JSON is what tells.
    expect(syncableDraftSchema.parse(preLoadListPush(withCrewNotes())).crewNotes).toBe('');
  });

  it('a push from an older build never erases the notes on the server', () => {
    const server = withCrewNotes();
    expect(fieldsPushWouldErase(preLoadListPush(server), stored(server))).toEqual(['crewNotes']);
    // A doc stored by an older build itself, or one with blank notes, has nothing to lose.
    expect(fieldsPushWouldErase(preLoadListPush(server), stored(wire(server, ['crewNotes'])))).toEqual([]);
    expect(fieldsPushWouldErase(preLoadListPush(server), stored({ ...server, crewNotes: '' }))).toEqual([]);
    expect(fieldsPushWouldErase(preLoadListPush(server), stored({ ...server, crewNotes: '  \n ' }))).toEqual([]);
    expect(fieldsPushWouldErase(preLoadListPush(server), stored({ ...server, crewNotes: 42 }))).toEqual([]);
    // A signed estimate is left to the sync function (locked: nothing is erased).
    expect(fieldsPushWouldErase(preLoadListPush(server), stored(server, 'signed'))).toEqual([]);
  });

  it('a current build clearing the notes on purpose sends crewNotes: "" and is applied', () => {
    const server = withCrewNotes();
    expect(fieldsPushWouldErase(wire({ ...server, crewNotes: '' }), stored(server))).toEqual([]);
  });

  it('a draft keeps up to 2,000 characters of notes for the crew, and defaults to none', () => {
    expect(newDraft().crewNotes).toBe('');
    expect(syncableDraftSchema.safeParse({ ...withCrewNotes(), crewNotes: 'x'.repeat(2000) }).success).toBe(true);
    expect(syncableDraftSchema.safeParse({ ...withCrewNotes(), crewNotes: 'x'.repeat(2001) }).success).toBe(false);
  });
});
