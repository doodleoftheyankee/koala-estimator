'use server';
// Owner-only learning-loop actions (PLAN.md §6.4): run the nightly job now, approve or reject the
// pending candidate set, and restore a past set.
//
// Every action re-checks that the caller is the owner. Approve, reject and restore call the
// coefficient RPCs with the owner's own client, so the database checks the role again and the
// changelog and audit log record the owner as the actor. The manual run uses the service role,
// exactly like the cron, and keeps every guardrail: a candidate is only promoted on its own when
// all gates pass and auto-promote is on.
import { revalidatePath } from 'next/cache';
import { redirect, RedirectType } from 'next/navigation';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { getSessionProfile } from '@/lib/server/auth';
import { runNightly } from '@/lib/learning/nightly';
import { errorMessage, failure, formToObject, parseWith, success, UNIQUE_VIOLATION, type ActionResult } from '@/lib/admin/forms';
import {
  approveForm,
  canRestore,
  decisionForm,
  nightlyResultMessage,
  noticeQuery,
  parseRow,
  SET_STATUSES,
  type LearningNotice,
} from '@/lib/admin/learning';

type Db = Awaited<ReturnType<typeof createClient>>;
type DbError = { code?: string; message: string } | null;

const PATH = '/admin/learning';
const NOT_OWNER = 'Only the owner can run learning or approve, reject or restore coefficient sets.';
const STALE_CANDIDATE =
  'This candidate is no longer waiting for approval: a newer nightly run replaced it, or it was already decided. Reload the page to see the current state.';

const setRefSchema = z.object({ id: z.string(), version: z.coerce.number(), status: z.enum(SET_STATUSES) });
type SetRef = z.infer<typeof setRefSchema>;

async function ownerDb(): Promise<{ db: Db; userId: string } | null> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return null;
  return { db: await createClient(), userId: profile.userId };
}

/** The set a decision is about, read with the owner's client (null when it does not exist). */
async function loadSet(db: Db, id: string): Promise<{ set: SetRef | null; error: string | null }> {
  const res = await db.from('coefficient_sets').select('id, version, status').eq('id', id).maybeSingle();
  if (res.error) return { set: null, error: `Loading the coefficient set failed: ${res.error.message}` };
  try {
    return { set: parseRow(setRefSchema, res.data, 'coefficient set'), error: null };
  } catch (e) {
    return { set: null, error: errorMessage(e) };
  }
}

function friendly(err: NonNullable<DbError>, what: string): string {
  if (/is not a candidate/i.test(err.message)) return STALE_CANDIDATE;
  if (err.code === '42501' || /only owner/i.test(err.message)) return NOT_OWNER;
  if (err.code === UNIQUE_VIOLATION) return 'Another change to the active set landed at the same moment. Reload the page and try again.';
  return `${what} failed: ${err.message}`;
}

/** Re-renders the dashboard (and the pricing page, which lists the active set) and shows a notice. */
function done(notice: LearningNotice): never {
  revalidatePath(PATH);
  revalidatePath('/admin/pricing');
  redirect(`${PATH}${noticeQuery(notice)}`, RedirectType.replace);
}

// ---------------------------------------------------------------------------
// Run the nightly job now
// ---------------------------------------------------------------------------

/** Takes no form fields; useActionState's (prev, formData) arguments are ignored. */
export async function runLearningNow(): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure(NOT_OWNER);

  let admin: ReturnType<typeof createAdminClient>;
  try {
    admin = createAdminClient();
  } catch (e) {
    return failure(`Learning cannot run on this server: ${errorMessage(e)}`);
  }

  let message: { ok: boolean; message: string };
  try {
    // Never throws for a failed step: each one is recorded in learning_runs and the summary.
    message = nightlyResultMessage(await runNightly(admin, new Date(), { trigger: 'manual', actorId: profile.userId }));
  } catch (e) {
    return failure(`The learning run could not start: ${errorMessage(e)}`);
  }
  revalidatePath(PATH);
  revalidatePath('/admin/pricing');
  return message.ok ? success(message.message) : failure(message.message);
}

// ---------------------------------------------------------------------------
// Approve / reject the pending candidate
// ---------------------------------------------------------------------------

export async function approveCandidate(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const parsed = parseWith(approveForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { set_id, reason } = parsed.data;
  const { db } = owner;

  const { set, error } = await loadSet(db, set_id);
  if (error) return failure(error);
  if (!set || set.status !== 'candidate') return failure(STALE_CANDIDATE);

  // promote_coefficient_set swaps the active set and writes one changelog row per moved coefficient.
  const reasonText = `Approved by the owner${reason ? `: ${reason}` : ''}`;
  const res = await db.rpc('promote_coefficient_set', { p_set_id: set.id, p_reason: reasonText });
  if (res.error) return failure(friendly(res.error, 'Approving the candidate'));

  done({ kind: 'approved', version: set.version, from: null });
}

export async function rejectCandidate(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const parsed = parseWith(decisionForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { set_id, reason } = parsed.data;
  const { db } = owner;

  const { set, error } = await loadSet(db, set_id);
  if (error) return failure(error);
  if (!set || set.status !== 'candidate') return failure(STALE_CANDIDATE);

  const res = await db.rpc('reject_coefficient_set', { p_set_id: set.id, p_reason: reason });
  if (res.error) return failure(friendly(res.error, 'Rejecting the candidate'));

  done({ kind: 'rejected', version: set.version, from: null });
}

// ---------------------------------------------------------------------------
// Restore a past set
// ---------------------------------------------------------------------------

export async function restoreSet(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const owner = await ownerDb();
  if (!owner) return failure(NOT_OWNER);
  const parsed = parseWith(decisionForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { set_id, reason } = parsed.data;
  const { db } = owner;

  const { set, error } = await loadSet(db, set_id);
  if (error) return failure(error);
  if (!set) return failure('That coefficient set no longer exists. Reload the page.');
  if (!canRestore(set.status)) {
    return failure(
      set.status === 'active'
        ? `v${set.version} is already the active set.`
        : `v${set.version} is a candidate: approve it instead of restoring it.`,
    );
  }

  // rollback_coefficient_set clones the target into a new set and promotes the clone; history is
  // never rewritten, and the changelog reason reads "rollback: <reason>".
  const res = await db.rpc('rollback_coefficient_set', { p_target_set_id: set.id, p_reason: `v${set.version} restored by the owner: ${reason}` });
  if (res.error) return failure(friendly(res.error, `Restoring v${set.version}`));

  let version: number | null = null;
  if (typeof res.data === 'string') {
    const created = await loadSet(db, res.data);
    version = created.set?.version ?? null;
  }
  done({ kind: 'restored', version, from: set.version });
}
