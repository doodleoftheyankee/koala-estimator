// Pure sync decisions, separated from IndexedDB/fetch so they can be unit tested.
import { draftSchema, syncableDraftSchema, type EstimateDraft } from '@/lib/sync/draft';
import type { RemoteEstimate, SyncResponse } from '@/lib/sync/protocol';
import type { LocalEstimate } from './db';

/** Is this draft complete enough to send? Returns the first problem, or null. */
export function syncBlocker(draft: EstimateDraft): string | null {
  const r = syncableDraftSchema.safeParse(draft);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  return issue.message;
}

/**
 * Applies a server response to the local record. `sentMutationId` is the mutation that was
 * sent; if the user edited while the request was in flight, the record has a newer
 * mutationId and must stay pending.
 */
export function applySyncResult(
  current: LocalEstimate,
  sentMutationId: string,
  res: SyncResponse,
  now: string,
): LocalEstimate {
  const editedSince = current.mutationId !== sentMutationId;
  switch (res.status) {
    case 'applied':
      return {
        ...current,
        draft: { ...current.draft, rowVersion: res.rowVersion, bundleHash: res.bundleHash },
        syncState: editedSince ? 'pending' : 'synced',
        lastError: null,
        serverDoc: null,
        serverRowVersion: null,
        syncedAt: now,
      };
    case 'conflict':
      return {
        ...current,
        syncState: 'conflict',
        serverDoc: parseDoc(res.serverDoc),
        serverRowVersion: res.rowVersion,
        lastError: 'Changed on another device.',
      };
    case 'locked': {
      const server = parseDoc(res.serverDoc);
      return {
        ...current,
        draft: server ? { ...server, status: 'signed', rowVersion: res.rowVersion } : { ...current.draft, status: 'signed' },
        syncState: 'locked',
        serverDoc: null,
        serverRowVersion: res.rowVersion,
        lastError: 'The customer already signed this quote. It can no longer be edited.',
      };
    }
    case 'invalid':
      return { ...current, syncState: 'invalid', lastError: res.error };
    case 'error':
      return { ...current, syncState: 'error', lastError: res.error };
  }
}

export function resolveConflict(current: LocalEstimate, choice: 'mine' | 'theirs', newMutationId: string): LocalEstimate {
  if (choice === 'theirs' && current.serverDoc) {
    return {
      ...current,
      draft: { ...current.serverDoc, rowVersion: current.serverRowVersion },
      mutationId: newMutationId,
      syncState: 'synced',
      serverDoc: null,
      serverRowVersion: null,
      lastError: null,
    };
  }
  // Keep mine: rebase onto the server's version so the next sync overwrites it.
  return {
    ...current,
    draft: { ...current.draft, rowVersion: current.serverRowVersion ?? current.draft.rowVersion },
    syncState: 'pending',
    mutationId: newMutationId,
    serverDoc: null,
    serverRowVersion: null,
    lastError: null,
  };
}

/**
 * Decides what to store when the server lists an estimate. Local unsynced edits always win
 * (they will sync next); otherwise the newer server copy replaces the local one.
 */
export function mergeRemote(
  local: LocalEstimate | undefined,
  remote: RemoteEstimate,
  ownerId: string,
  newMutationId: string,
): LocalEstimate | null {
  const doc = parseDoc(remote.doc);
  if (!doc) return null;
  const draft: EstimateDraft = { ...doc, status: asStatus(remote.status, doc.status), rowVersion: remote.rowVersion };
  if (local && ['pending', 'conflict', 'invalid', 'error', 'local'].includes(local.syncState)) return null;
  if (local && local.draft.rowVersion !== null && local.draft.rowVersion >= remote.rowVersion && local.draft.status === draft.status) {
    return null; // already up to date
  }
  return {
    id: remote.id,
    ownerId: local?.ownerId ?? ownerId,
    draft,
    syncState: draft.status === 'signed' ? 'locked' : 'synced',
    // A new mutation id tells an open editor that the stored copy changed underneath it.
    mutationId: newMutationId,
    lastError: null,
    serverDoc: null,
    serverRowVersion: null,
    updatedAt: remote.updatedAt,
    syncedAt: remote.updatedAt,
  };
}

/** Marks a local edit. Every edit gets a fresh mutation id. */
export function touch(current: LocalEstimate, draft: EstimateDraft, newMutationId: string, now: string): LocalEstimate {
  // Editing a sent quote starts a new revision; the next send creates quote version n+1.
  const status = ['sent', 'viewed', 'expired', 'lost'].includes(draft.status) ? 'draft' : draft.status;
  draft = { ...draft, status };
  const blocked = syncBlocker(draft);
  const keepState = current.syncState === 'conflict' || current.syncState === 'locked';
  return {
    ...current,
    draft: { ...draft, updatedAt: now },
    mutationId: newMutationId,
    syncState: keepState ? current.syncState : blocked ? 'local' : 'pending',
    lastError: keepState ? current.lastError : blocked,
    updatedAt: now,
  };
}

function parseDoc(doc: unknown): EstimateDraft | null {
  const r = draftSchema.safeParse(doc);
  return r.success ? r.data : null;
}

const STATUSES = new Set(['draft', 'ready', 'sent', 'viewed', 'signed', 'lost', 'expired', 'void']);
function asStatus(s: string, fallback: EstimateDraft['status']): EstimateDraft['status'] {
  return STATUSES.has(s) ? (s as EstimateDraft['status']) : fallback;
}
