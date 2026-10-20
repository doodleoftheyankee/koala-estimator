// Protects estimates from phones running an older build of the app. The phone parses drafts with
// its own draftSchema, and z.object strips keys it does not know: a Phase 1 build has no
// lineOverrides or deviationAcks. If such a phone pulls an estimate that has them, fixes a typo and
// pushes, the server's schema would default both to {} and the sync would store client_doc
// without them, re-price the lines at model values and delete the acknowledged deviation flags.
// /api/sync refuses that push instead (status 'invalid', which every build shows). Pure.

/** Draft fields added after Phase 1, which an older build drops without knowing they exist. */
export const LATER_DRAFT_FIELDS = ['lineOverrides', 'deviationAcks'] as const;
export type LaterDraftField = (typeof LATER_DRAFT_FIELDS)[number];

/** Shown on the phone ("Server rejected this estimate: …"). Nothing was saved on the server. */
export const OUTDATED_APP_ERROR =
  'This estimate has line changes or notes made in a newer version of the app, and this version would erase them, so nothing was saved. Reload the app to update it.';

/** The stored estimates row the check reads, or null when there is none (a new estimate). */
export interface StoredEstimate {
  status: string | null;
  client_doc: unknown;
}

/**
 * Later fields the incoming draft does not have at all, read from the JSON exactly as received
 * (before draftSchema fills in defaults). A field that is present but empty ({}) is not missing:
 * that is a current build clearing it on purpose.
 */
export function missingDraftFields(rawDraft: unknown): LaterDraftField[] {
  if (!isPlainObject(rawDraft)) return [];
  return LATER_DRAFT_FIELDS.filter((f) => !Object.hasOwn(rawDraft, f));
}

/**
 * The fields this push would erase: missing from the incoming draft but non-empty in the stored
 * client_doc. Empty means the push is safe to apply. A signed estimate is left to
 * sync_upsert_estimate, which refuses it as 'locked' (erasing nothing) and tells the phone it is
 * read-only.
 */
export function fieldsPushWouldErase(rawDraft: unknown, stored: StoredEstimate | null): LaterDraftField[] {
  const missing = missingDraftFields(rawDraft);
  if (!missing.length || !stored || stored.status === 'signed') return [];
  const doc = stored.client_doc;
  if (!isPlainObject(doc)) return [];
  return missing.filter((f) => Object.hasOwn(doc, f) && isNonEmptyObject(doc[f]));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonEmptyObject(v: unknown): boolean {
  return isPlainObject(v) && Object.keys(v).length > 0;
}
