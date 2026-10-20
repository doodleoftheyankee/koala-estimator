'use server';
// Estimate outcomes the office records by hand. Writes go through the signed-in user's client:
// RLS lets owner/office change any estimate and an estimator only their own.
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { getSessionProfile } from '@/lib/server/auth';
import { failure, formToObject, parseWith, success, type ActionResult } from '@/lib/admin/forms';
import { LOSABLE_STATUSES, markLostForm } from '@/lib/jobs/forms';

/** The customer said no (or went quiet): record why. Feeds the win-rate model as a loss. */
export async function markLost(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role === 'crew') return failure('Your role cannot change estimates.');
  const parsed = parseWith(markLostForm, formToObject(fd));
  if (!parsed.ok) return failure(parsed.error);
  const { id, reason } = parsed.data;

  const db = await createClient();
  let q = db
    .from('estimates')
    .update({ status: 'lost', lost_reason: reason, decided_at: new Date().toISOString() })
    .eq('id', id)
    .in('status', [...LOSABLE_STATUSES]);
  if (profile.role === 'estimator') q = q.eq('estimator_id', profile.userId);
  const res = await q.select('id');
  if (res.error) return failure(`Saving failed: ${res.error.message}`);
  if (!res.data?.length) return failure('This estimate cannot be marked lost: it is already signed, lost or void, or it is not yours.');

  // Close any open quote so the customer cannot sign a lost estimate (which would book a job).
  // Quotes are written only by the server; RLS above already proved this user may change it.
  const admin = createAdminClient();
  const closed = await admin
    .from('quotes')
    .update({ status: 'declined' })
    .eq('estimate_id', id)
    .in('status', ['sent', 'viewed'])
    .select('id');
  if (closed.error) return failure(`Marked lost, but the open quote could not be closed: ${closed.error.message}`);
  if (closed.data?.length) {
    await admin
      .from('quote_events')
      .insert(closed.data.map((q) => ({ quote_id: q.id, event: 'declined', meta: { by: profile.userId, source: 'office', reason } })));
  }

  revalidatePath('/estimates');
  return success('Marked lost.');
}
