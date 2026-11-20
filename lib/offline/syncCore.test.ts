import { OUTDATED_APP_ERROR } from '@/lib/sync/compat';
import { newMeasurement } from '@/lib/measure/measure';
import { describe, expect, it } from 'vitest';
import { newArea, newDraft, type EstimateDraft } from '@/lib/sync/draft';
import { toRow, waitingTotal } from '@/lib/field/estimateList';
import type { LocalEstimate } from './db';
import type { RemoteEstimate } from '@/lib/sync/protocol';
import { applySyncResult, mergeRemote, resolveConflict, saveEdit, sameWork, syncBlocker, touch, UNSENT_CHANGE_DROPPED } from './syncCore';

const NOW = '2026-10-20T12:00:00.000Z';
/** New drafts start in the business profile's town (L32); these tests' estimates are in this one. */
const TOWN = { city: 'Springfield', state: 'IL' };
function complete(): EstimateDraft {
  const d = newDraft(new Date(NOW), undefined, TOWN);
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
  it('a change made before the phone heard of the signature is dropped, and the estimator is told (L35)', () => {
    // The phone edited a sent quote offline (touch: a new draft revision) while the customer signed.
    const sent = { ...complete(), status: 'sent' as const, rowVersion: 4, notes: 'before' };
    const edited = touch(record({ draft: sent, syncState: 'synced' }), { ...sent, notes: 'my unsent change' }, 'm1', NOW);
    expect(edited.draft.status).toBe('draft');
    const r = applySyncResult(edited, 'm1', { status: 'locked', rowVersion: 5, serverDoc: { ...sent, status: 'signed', rowVersion: 5 } }, NOW);
    expect(r).toMatchObject({ syncState: 'locked', serverDoc: null, serverRowVersion: 5 });
    expect(r.draft).toMatchObject({ status: 'signed', rowVersion: 5, notes: 'before' });
    expect(r.lastError).toBe(UNSENT_CHANGE_DROPPED);
    expect(UNSENT_CHANGE_DROPPED).toBe('Your unsent change was not applied.');
    // Nothing more is sent: a locked estimate is not edited or queued again.
    expect(touch(r, { ...r.draft, notes: 'again' }, 'm2', NOW).syncState).toBe('locked');
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

describe('release review C FLOW-2: the row keeps its headline when the server copy replaces the phone copy', () => {
  const remote = (over: Record<string, unknown> = {}) => {
    const d = complete();
    return { id: d.id, status: 'sent', rowVersion: 3, updatedAt: NOW, doc: d, ...over };
  };
  const sentLocal = () =>
    record({ syncState: 'synced', draft: { ...complete(), status: 'sent', rowVersion: 3 }, summaryPrice: 3975, summaryTier: 'better' });
  const now = new Date(NOW);

  it("a status-only change from the server (sent -> viewed -> signed) keeps the row's price and the waiting total", () => {
    const local = sentLocal();
    expect(toRow(local, now).price).toBe(3975);
    const viewed = mergeRemote(local, remote({ status: 'viewed' }), 'u1', 'm2')!;
    expect(viewed).toMatchObject({ summaryPrice: 3975, summaryTier: 'better' });
    const row = toRow(viewed, now);
    expect(row.price).toBe(3975);
    expect(row.priceLabel).toBe('Better');
    expect(waitingTotal([row])).toEqual({ total: 3975, count: 1 });
    const signed = mergeRemote(viewed, remote({ status: 'signed' }), 'u1', 'm3')!;
    expect(signed).toMatchObject({ syncState: 'locked', summaryPrice: 3975, summaryTier: 'better' });
    expect(toRow(signed, now).price).toBe(3975);
  });

  it("an estimate pulled from the server shows the server's headline (the signed price, or the recommended option)", () => {
    const pulled = mergeRemote(undefined, remote({ status: 'signed', headline: { price: 5060, tier: 'better' } }), 'u1', 'm')!;
    expect(toRow(pulled, now)).toMatchObject({ price: 5060, priceLabel: 'Better' });
    // The server's headline wins over the phone's when the server moved on.
    const moved = mergeRemote(sentLocal(), remote({ rowVersion: 4, headline: { price: 4100, tier: 'best' } }), 'u1', 'm')!;
    expect(moved).toMatchObject({ summaryPrice: 4100, summaryTier: 'best' });
  });

  it('readiness walk W1: a signed estimate recommends the option the customer signed, not the earlier pick', () => {
    // The estimator recommended Best; the customer signed Better at 5,060.
    const picked = { ...complete(), status: 'sent' as const, rowVersion: 3, selectedTier: 'best' as const };
    const local = record({ syncState: 'synced', draft: picked, summaryPrice: 9900, summaryTier: 'best' });
    const signed = mergeRemote(local, remote({ status: 'signed', rowVersion: 4, doc: picked, headline: { price: 5060, tier: 'better' } }), 'u1', 'm')!;
    expect(signed).toMatchObject({ syncState: 'locked', summaryPrice: 5060, summaryTier: 'better' });
    // The draft keeps the option the quote highlighted, which is what the customer was shown (review W1-b).
    expect(signed.draft).toMatchObject({ status: 'signed', selectedTier: 'best' });
    expect(toRow(signed, now)).toMatchObject({ price: 5060, priceLabel: 'Better' });
    // An unsigned estimate keeps the estimator's pick.
    const sent = mergeRemote(local, remote({ status: 'viewed', rowVersion: 4, doc: picked, headline: { price: 9900, tier: 'best' } }), 'u1', 'm')!;
    expect(sent.draft.selectedTier).toBe('best');
  });

  it("readiness walk W1: a phone told 'locked' on a push drops its own headline, and the next pull fills in the signed one", () => {
    const sent = { ...complete(), status: 'sent' as const, rowVersion: 4, selectedTier: 'best' as const };
    const edited = touch(record({ draft: sent, syncState: 'synced', summaryPrice: 9900, summaryTier: 'best' }), { ...sent, notes: 'x' }, 'm1', NOW);
    const locked = applySyncResult(edited, 'm1', { status: 'locked', rowVersion: 5, serverDoc: { ...sent, status: 'signed', rowVersion: 5 } }, NOW);
    expect(locked).toMatchObject({ syncState: 'locked', summaryPrice: null, summaryTier: null });
    // Same row version and status as the server: before W1 this was 'already up to date' and kept no price.
    const pulled = mergeRemote(locked, remote({ status: 'signed', rowVersion: 5, doc: sent, headline: { price: 5060, tier: 'better' } }), 'u1', 'm2')!;
    expect(pulled).toMatchObject({ syncState: 'locked', summaryPrice: 5060, summaryTier: 'better' });
    // The estimator is still told the unsent change was not applied (L35).
    expect(pulled.lastError).toBe(UNSENT_CHANGE_DROPPED);
    expect(pulled.draft.selectedTier).toBe('best');
    // Once it has the signed headline, the same copy is up to date again.
    expect(mergeRemote(pulled, remote({ status: 'signed', rowVersion: 5, doc: sent, headline: { price: 5060, tier: 'better' } }), 'u1', 'm3')).toBeNull();
  });
});

describe('walk-fix review W1-d: a phone holding an unsent edit learns the customer signed', () => {
  const remote = (over: Partial<RemoteEstimate> = {}): RemoteEstimate => {
    const d = complete();
    return { id: d.id, status: 'signed', rowVersion: 6, updatedAt: NOW, doc: { ...d, status: 'sent', rowVersion: 6 }, headline: { price: 5060, tier: 'better' }, ...over };
  };
  it.each(['local', 'conflict', 'invalid', 'error'] as const)('a %s edit is replaced by the signed copy, read-only, and the estimator is told', (state) => {
    const sent = { ...complete(), status: 'sent' as const, rowVersion: 4, selectedTier: 'best' as const };
    const mine = record({ draft: { ...sent, status: 'draft', notes: 'my unfinished change' }, syncState: state, summaryPrice: 9900, summaryTier: 'best' });
    const merged = mergeRemote(mine, remote(), 'u1', 'm9')!;
    expect(merged).toMatchObject({ syncState: 'locked', lastError: UNSENT_CHANGE_DROPPED, summaryPrice: 5060, summaryTier: 'better', mutationId: 'm9' });
    expect(merged.draft).toMatchObject({ status: 'signed', rowVersion: 6 });
    expect(merged.draft.notes).not.toBe('my unfinished change');
    expect(touch(merged, { ...merged.draft, notes: 'again' }, 'm10', NOW).syncState).toBe('locked');
  });
  it('a pending edit is left for its push, which hears locked (L35)', () => {
    const mine = record({ draft: { ...complete(), status: 'draft', rowVersion: 4 }, syncState: 'pending' });
    expect(mergeRemote(mine, remote(), 'u1', 'm9')).toBeNull();
  });
  it('an unsigned server copy still never replaces an unsent edit', () => {
    const mine = record({ draft: { ...complete(), status: 'draft', rowVersion: 4 }, syncState: 'local' });
    expect(mergeRemote(mine, remote({ status: 'viewed' }), 'u1', 'm9')).toBeNull();
  });
});

describe('walk-fix review EE-2: a save never silently overwrites another device change', () => {
  const synced = (draft: EstimateDraft, mutationId: string) => record({ draft, syncState: 'synced', mutationId });
  it('another device saved while this phone was typing: the save is a conflict, mine against theirs', () => {
    const start = { ...complete(), rowVersion: 5, notes: 'start' };
    const theirs = { ...start, rowVersion: 6, notes: 'from the office' };
    // The pull replaced the stored copy underneath the typing (a new mutation id).
    const cur = synced(theirs, 'pulled');
    const saved = saveEdit(cur, { ...start, customer: { ...start.customer, firstName: 'Robin' } }, 'm2', NOW, { mutationId: 'adopted', draft: start });
    expect(saved).toMatchObject({ syncState: 'conflict', serverRowVersion: 6, lastError: 'Changed on another device.', mutationId: 'm2' });
    expect(saved.serverDoc?.notes).toBe('from the office');
    expect(saved.draft.customer.firstName).toBe('Robin');
    // Keep mine rebases onto their version; take theirs keeps the office's change.
    expect(resolveConflict(saved, 'mine', 'm3')).toMatchObject({ syncState: 'pending', draft: { rowVersion: 6 } });
    expect(resolveConflict(saved, 'theirs', 'm3').draft.notes).toBe('from the office');
  });
  it('a copy that changed only in the server fields (viewed, sent, this phone own push) is a normal save', () => {
    const start = { ...complete(), status: 'sent' as const, rowVersion: 5 };
    const viewed = { ...start, status: 'viewed' as const, rowVersion: 7, updatedAt: '2026-11-19T16:00:00Z' };
    const saved = saveEdit(synced(viewed, 'pulled'), { ...start, notes: 'more' }, 'm2', NOW, { mutationId: 'adopted', draft: start });
    expect(saved.syncState).toBe('pending');
    expect(saved.draft).toMatchObject({ rowVersion: 7, notes: 'more', status: 'draft' });
    // The same mutation id (this phone's own push kept it): a normal save at the new row version.
    const own = saveEdit(synced({ ...start, rowVersion: 8 }, 'adopted'), { ...start, notes: 'x' }, 'm3', NOW, { mutationId: 'adopted', draft: start });
    expect(own).toMatchObject({ syncState: 'pending', draft: { rowVersion: 8 } });
  });
  it('sameWork ignores key order and the server fields only', () => {
    const a = complete();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as EstimateDraft;
    expect(sameWork(a, reordered)).toBe(true);
    expect(sameWork(a, { ...a, rowVersion: 9, status: 'viewed', updatedAt: 'x' })).toBe(true);
    expect(sameWork(a, { ...a, notes: 'different' })).toBe(false);
  });
});
