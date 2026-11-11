import { OUTDATED_APP_ERROR } from '@/lib/sync/compat';
import { newMeasurement } from '@/lib/measure/measure';
import { describe, expect, it } from 'vitest';
import { newArea, newDraft, type EstimateDraft } from '@/lib/sync/draft';
import type { LocalEstimate } from './db';
import { applySyncResult, mergeRemote, resolveConflict, syncBlocker, touch } from './syncCore';

const NOW = '2026-10-20T12:00:00.000Z';
function complete(): EstimateDraft {
  const d = newDraft(new Date(NOW));
  d.customer = { ...d.customer, firstName: 'Pat', lastName: 'Lee' };
  d.property = { ...d.property, street: '1 Main', zip: '19711' };
  d.areas = [{ ...newArea('attic'), sqft: 900 }];
  return d;
}
function record(over: Partial<LocalEstimate> = {}): LocalEstimate {
  const draft = complete();
  return { id: draft.id, ownerId: 'u1', draft, syncState: 'pending', mutationId: 'm1', lastError: null, serverDoc: null, serverRowVersion: null, updatedAt: NOW, syncedAt: null, ...over };
}

describe('syncBlocker', () => {
  it('explains what is missing', () => {
    expect(syncBlocker(newDraft())).toBeTruthy();
    expect(syncBlocker(complete())).toBeNull();
    expect(syncBlocker({ ...complete(), areas: [] })).toBe('Add at least one area');
  });
});

describe('touch', () => {
  it('assigns a new mutation id and marks pending when complete', () => {
    const r = touch(record({ syncState: 'synced' }), complete(), 'm2', NOW);
    expect(r).toMatchObject({ mutationId: 'm2', syncState: 'pending', lastError: null });
  });
  it('stays local while incomplete', () => {
    const r = touch(record(), newDraft(), 'm2', NOW);
    expect(r.syncState).toBe('local');
    expect(r.lastError).toBeTruthy();
  });
  it('editing a sent estimate starts a new draft revision', () => {
    const r = touch(record(), { ...complete(), status: 'sent' }, 'm2', NOW);
    expect(r.draft.status).toBe('draft');
  });
  it('does not clear a conflict or lock', () => {
    expect(touch(record({ syncState: 'conflict' }), complete(), 'm2', NOW).syncState).toBe('conflict');
    expect(touch(record({ syncState: 'locked' }), complete(), 'm2', NOW).syncState).toBe('locked');
  });
});

describe('applySyncResult', () => {
  const applied = { status: 'applied', rowVersion: 3, bundleHash: 'h', repriced: false } as const;
  it('marks synced and stores the new row version', () => {
    const r = applySyncResult(record(), 'm1', applied, NOW);
    expect(r.syncState).toBe('synced');
    expect(r.draft.rowVersion).toBe(3);
    expect(r.draft.bundleHash).toBe('h');
  });
  it('stays pending if edited while in flight', () => {
    const r = applySyncResult(record({ mutationId: 'm2' }), 'm1', applied, NOW);
    expect(r.syncState).toBe('pending');
    expect(r.draft.rowVersion).toBe(3);
  });
  it('records conflicts with the server copy', () => {
    const server = { ...complete(), notes: 'from phone 2' };
    const r = applySyncResult(record(), 'm1', { status: 'conflict', rowVersion: 5, serverDoc: server }, NOW);
    expect(r.syncState).toBe('conflict');
    expect(r.serverDoc?.notes).toBe('from phone 2');
    expect(r.serverRowVersion).toBe(5);
  });
  it('locks signed estimates', () => {
    const r = applySyncResult(record(), 'm1', { status: 'locked', rowVersion: 9, serverDoc: complete() }, NOW);
    expect(r.syncState).toBe('locked');
    expect(r.draft.status).toBe('signed');
    const noDoc = applySyncResult(record(), 'm1', { status: 'locked', rowVersion: 9, serverDoc: null }, NOW);
    expect(noDoc.draft.status).toBe('signed');
  });
  it('keeps errors for retry or fixing', () => {
    expect(applySyncResult(record(), 'm1', { status: 'invalid', error: 'bad zip' }, NOW)).toMatchObject({ syncState: 'invalid', lastError: 'bad zip' });
    expect(applySyncResult(record(), 'm1', { status: 'error', error: 'offline' }, NOW)).toMatchObject({ syncState: 'error' });
  });
});

describe('resolveConflict', () => {
  const conflicted = record({ syncState: 'conflict', serverDoc: { ...complete(), notes: 'theirs' }, serverRowVersion: 7 });
  it('theirs replaces the local draft', () => {
    const r = resolveConflict(conflicted, 'theirs', 'm9');
    expect(r).toMatchObject({ syncState: 'synced', serverDoc: null });
    expect(r.draft.notes).toBe('theirs');
    expect(r.draft.rowVersion).toBe(7);
  });
  it('mine rebases onto the server version and re-queues', () => {
    const r = resolveConflict(conflicted, 'mine', 'm9');
    expect(r).toMatchObject({ syncState: 'pending', mutationId: 'm9' });
    expect(r.draft.rowVersion).toBe(7);
  });
});

describe('mergeRemote', () => {
  const remote = (over: Partial<{ rowVersion: number; status: string; doc: unknown }> = {}) => {
    const d = complete();
    return { id: d.id, status: 'draft', rowVersion: 2, updatedAt: NOW, doc: d, ...over };
  };
  it('adds estimates the device does not have', () => {
    const r = mergeRemote(undefined, remote(), 'u1', 'm');
    expect(r).toMatchObject({ syncState: 'synced', ownerId: 'u1' });
    expect(r!.draft.rowVersion).toBe(2);
  });
  it('never overwrites unsynced local edits', () => {
    expect(mergeRemote(record({ syncState: 'pending' }), remote(), 'u1', 'm')).toBeNull();
  });
  it('skips when already current, updates when the server moved on', () => {
    const local = record({ syncState: 'synced', draft: { ...complete(), rowVersion: 2 } });
    expect(mergeRemote(local, remote(), 'u1', 'm')).toBeNull();
    expect(mergeRemote(local, remote({ rowVersion: 3 }), 'u1', 'm')).not.toBeNull();
  });
  it('picks up server-side status changes and locks signed ones', () => {
    const local = record({ syncState: 'synced', draft: { ...complete(), rowVersion: 2 } });
    const r = mergeRemote(local, remote({ status: 'signed' }), 'u1', 'm');
    expect(r).toMatchObject({ syncState: 'locked' });
    expect(r!.draft.status).toBe('signed');
  });
  it('fills fields an older build left out, so the next edit cannot erase them on the server', () => {
    const server: EstimateDraft = { ...complete(), measurements: { a: newMeasurement('attic') } };
    const oldCopy = JSON.parse(JSON.stringify(complete())) as Record<string, unknown>;
    delete oldCopy.measurements;
    delete oldCopy.photoReads;
    const outdated = record({ syncState: 'invalid', lastError: OUTDATED_APP_ERROR, draft: { ...(oldCopy as unknown as EstimateDraft), rowVersion: 2 } });
    const r = mergeRemote(outdated, remote({ doc: server }), 'u1', 'm2')!;
    expect(r.draft.measurements).toEqual(server.measurements);
    expect(r.draft.photoReads).toEqual({});
    expect(r).toMatchObject({ syncState: 'pending', lastError: null, mutationId: 'm2' });
    // Local edits stay; only the missing fields come from the server.
    const editing = record({ syncState: 'pending', draft: { ...(oldCopy as unknown as EstimateDraft), notes: 'mine', rowVersion: 1 } });
    const e = mergeRemote(editing, remote({ doc: server }), 'u1', 'm3')!;
    expect(e).toMatchObject({ syncState: 'pending' });
    expect(e.draft.notes).toBe('mine');
    expect(e.draft.measurements).toEqual(server.measurements);
  });

  it('ignores malformed remote docs and unknown statuses', () => {
    expect(mergeRemote(undefined, remote({ doc: { nope: true } }), 'u1', 'm')).toBeNull();
    expect(mergeRemote(undefined, remote({ status: 'weird' }), 'u1', 'm')!.draft.status).toBe('draft');
  });
});
