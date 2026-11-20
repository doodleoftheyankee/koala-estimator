// Pure sync decisions, separated from IndexedDB/fetch so they can be unit tested.
import { draftSchema, syncableDraftSchema, type EstimateDraft } from '@/lib/sync/draft';
import type { RemoteEstimate, SyncResponse } from '@/lib/sync/protocol';
import { missingDraftFields, OUTDATED_APP_ERROR } from '@/lib/sync/compat';
import type { LocalEstimate } from './db';

/** Is this draft complete enough to send? Returns the first problem, or null. */
export function syncBlocker(draft: EstimateDraft): string | null {
  const r = syncableDraftSchema.safeParse(draft);
  if (r.success) return null;
  const issue = r.error.issues[0]!;
  return issue.message;
}

/**
 * What a phone with an unsent change is told once it learns the customer signed: the signed quote
 * replaces its copy and the change is not applied (L35, RF-05). Never a "changed on another device".
 */
export const UNSENT_CHANGE_DROPPED = 'Your unsent change was not applied.';

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
        // Only a phone with something to send hears 'locked': that change is dropped (L35).
        lastError: UNSENT_CHANGE_DROPPED,
        // The phone's headline was its own pick, not what the customer signed: the pull that follows
        // every push fills in the signed price (mergeRemote), and nothing claims it until then.
        summaryPrice: null,
        summaryTier: null,
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
  const status = asStatus(remote.status, doc.status);
  // A signed estimate's headline is what the customer signed (the server's: the signed price and
  // option), for the list and the editor's dock (readiness walk W1). The draft is the server's copy
  // as it is: its pick is not rewritten to the signed option (review W1-b), and the Options step
  // marks the signed option itself (recheck W1-R1).
  const signed = status === 'signed' && remote.headline ? remote.headline : null;
  const draft: EstimateDraft = { ...doc, status, rowVersion: remote.rowVersion };
  // The customer signed while this phone held an edit it has not sent (unfinished, refused or in
  // conflict): the signed copy replaces it, read-only, and the estimator is told the change was not
  // applied, as when a push hears 'locked' (L35). A pending edit hears 'locked' on its push instead.
  // (Walk-fix review W1-d: the phone never learned of the signature.)
  if (status === 'signed' && local && ['local', 'conflict', 'invalid', 'error'].includes(local.syncState)) {
    return {
      ...local,
      draft,
      syncState: 'locked',
      mutationId: newMutationId,
      lastError: UNSENT_CHANGE_DROPPED,
      serverDoc: null,
      serverRowVersion: null,
      updatedAt: remote.updatedAt,
      syncedAt: remote.updatedAt,
      summaryPrice: signed ? signed.price : null,
      summaryTier: signed ? signed.tier : null,
    };
  }
  // A copy saved by an older build lacks fields added since (photo reads, measurements…). Fill
  // them from the server before anything else, or the next edit would send empty ones and erase
  // the server's. A push refused for exactly that reason can then go through.
  const missing = local ? missingDraftFields(local.draft) : [];
  if (local && missing.length) {
    const filled = { ...local.draft, ...Object.fromEntries(missing.map((f) => [f, draft[f]])) } as EstimateDraft;
    const unblocked = local.syncState === 'invalid' && local.lastError === OUTDATED_APP_ERROR;
    if (local.syncState !== 'synced' || local.draft.rowVersion === null || local.draft.rowVersion >= remote.rowVersion) {
      return {
        ...local,
        draft: filled,
        mutationId: newMutationId,
        ...(unblocked ? { syncState: 'pending' as const, lastError: null } : {}),
      };
    }
  }
  if (local && ['pending', 'conflict', 'invalid', 'error', 'local'].includes(local.syncState)) return null;
  // A signed copy whose headline is not yet the signed one (the phone heard 'locked' on a push, or
  // stored its own pick) takes the server's, even at the same row version.
  const headlineBehind = signed !== null && (local?.summaryPrice !== signed.price || (signed.tier !== null && local?.summaryTier !== signed.tier));
  if (local && !headlineBehind && local.draft.rowVersion !== null && local.draft.rowVersion >= remote.rowVersion && local.draft.status === draft.status) {
    return null; // already up to date
  }
  return {
    id: remote.id,
    ownerId: local?.ownerId ?? ownerId,
    draft,
    syncState: draft.status === 'signed' ? 'locked' : 'synced',
    // A new mutation id tells an open editor that the stored copy changed underneath it.
    mutationId: newMutationId,
    // A signed copy refreshed only for its headline keeps telling the estimator their unsent change
    // was dropped (L35); anything else starts clean.
    lastError: local?.syncState === 'locked' && local.lastError === UNSENT_CHANGE_DROPPED && draft.status === 'signed' ? UNSENT_CHANGE_DROPPED : null,
    serverDoc: null,
    serverRowVersion: null,
    updatedAt: remote.updatedAt,
    syncedAt: remote.updatedAt,
    // The row's headline (OD1): the server's when it sends one, else the phone's own, so a status
    // the server changed (viewed, signed) never drops the price (release review C FLOW-2).
    summaryPrice: remote.headline ? remote.headline.price : (local?.summaryPrice ?? null),
    summaryTier: remote.headline ? remote.headline.tier : (local?.summaryTier ?? null),
  };
}

/** The fields the server owns or stamps: they never make two copies of an estimate different work. */
const SERVER_FIELDS = new Set(['rowVersion', 'status', 'lastQuote', 'bundleHash', 'updatedAt']);
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}
/** Two copies of an estimate hold the same work: everything but the server's own fields is equal. */
export function sameWork(a: EstimateDraft, b: EstimateDraft): boolean {
  const strip = (d: EstimateDraft) => {
    const parsed = parseDoc(d) ?? d;
    return JSON.stringify(canonical(Object.fromEntries(Object.entries(parsed).filter(([k]) => !SERVER_FIELDS.has(k)))));
  };
  return strip(a) === strip(b);
}

/**
 * What the editor stores when it saves: the form's work on top of the stored copy's server fields,
 * marked as a local edit (touch). `base` is the stored copy the editor's typing started from (its
 * mutation id and draft). If a sync replaced that copy underneath the typing with different work
 * (another device saved meanwhile), the save is stored as a conflict, mine against theirs, instead
 * of taking the new row version and silently overwriting the other change (walk-fix review EE-2).
 * A copy that changed only in the server's own fields (viewed, sent, a new row version from this
 * phone's own push) is not a conflict.
 */
export function saveEdit(
  cur: LocalEstimate,
  form: EstimateDraft,
  mutationId: string,
  now: string,
  base: { mutationId: string | null; draft: EstimateDraft | null },
): LocalEstimate {
  const merged: EstimateDraft = {
    ...form,
    rowVersion: cur.draft.rowVersion,
    bundleHash: cur.draft.bundleHash,
    lastQuote: cur.draft.lastQuote,
    status: cur.draft.status,
  };
  const touched = touch(cur, merged, mutationId, now);
  const replaced =
    cur.syncState === 'synced' &&
    base.mutationId !== null &&
    base.draft !== null &&
    cur.mutationId !== base.mutationId &&
    !sameWork(base.draft, cur.draft);
  if (!replaced) return touched;
  return {
    ...touched,
    syncState: 'conflict',
    serverDoc: cur.draft,
    serverRowVersion: cur.draft.rowVersion,
    lastError: 'Changed on another device.',
  };
}

/**
 * What the phone stores once a quote went out. `sentFrom` is the mutation id of the copy that was
 * synced and sent; `clientDoc` is the server's copy after sending (status sent, the new quote), and
 * `rowVersion` its row version. If the estimator kept editing while the quote was being made (the
 * stored copy has another mutation id), that edit is kept as a new revision of the sent quote on
 * the server's new row version, instead of being replaced by the server's copy and then reported
 * as "Changed on another device" (walk-fix recheck EE2-R1).
 */
export function afterSend(
  cur: LocalEstimate,
  sentFrom: string,
  clientDoc: EstimateDraft | null,
  rowVersion: number | null,
  newMutationId: string,
  now: string,
): LocalEstimate {
  if (cur.mutationId !== sentFrom && cur.syncState !== 'locked') {
    return {
      ...cur,
      draft: {
        ...cur.draft,
        rowVersion: rowVersion ?? cur.draft.rowVersion,
        lastQuote: clientDoc?.lastQuote ?? cur.draft.lastQuote,
        // An edit made after the quote went out starts the next revision (as touch does for a sent quote).
        status: ['sent', 'viewed', 'expired', 'lost'].includes(cur.draft.status) ? 'draft' : cur.draft.status,
      },
      syncState: cur.syncState === 'local' || cur.syncState === 'invalid' ? cur.syncState : 'pending',
    };
  }
  return {
    ...cur,
    draft: clientDoc ? { ...clientDoc, rowVersion } : { ...cur.draft, status: 'sent', rowVersion },
    syncState: 'synced',
    mutationId: newMutationId,
    lastError: null,
    syncedAt: now,
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
