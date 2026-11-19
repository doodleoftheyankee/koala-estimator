import 'server-only';
// Price approvals on the server (L34): what a request is checked against before it is queued, and
// the plain answer when a decision is refused. The database enforces who may ask and decide (RLS on
// price_approvals); these checks give the reason in words and keep the queue to real questions.
import { canSendQuote, priceEstimate, TIERS, type PolicyProblem, type Role, type Tier } from '@/lib/pricing';
import { loadPricingBundle } from '@/lib/server/bundle';
import { draftSchema, priceableAreas, toEstimateInput } from '@/lib/sync/draft';
import type { createClient } from '@/lib/supabase/server';

type Db = Awaited<ReturnType<typeof createClient>>;

export type RequestCheck =
  | { ok: true; problem: PolicyProblem & { price: number; modelPrice: number } }
  | { ok: false; status: number; error: string; message: string };

/**
 * Prices the estimate as the server has it and finds the option's price problem for this role. The
 * request must be for the price the option has now (the phone syncs first), and that price must be
 * one the role cannot send alone.
 */
export async function checkApprovalRequest(db: Db, role: Role, estimateId: string, tier: Tier, price: number): Promise<RequestCheck> {
  const { data, error } = await db.from('estimates').select('id, status, client_doc').eq('id', estimateId).maybeSingle();
  if (error) throw new Error(`Loading the estimate failed: ${error.message}`);
  if (!data) return { ok: false, status: 404, error: 'not_found', message: 'Estimate not found.' };
  if (data.status === 'signed') return { ok: false, status: 409, error: 'signed', message: 'The customer already signed this quote.' };
  const parsed = draftSchema.safeParse(data.client_doc);
  if (!parsed.success) return { ok: false, status: 409, error: 'not_synced', message: 'This estimate is not saved to the office yet. Sync it, then ask again.' };
  const draft = parsed.data;
  const bundle = await loadPricingBundle(db);
  const priced = priceEstimate({ ...toEstimateInput(draft), areas: priceableAreas(draft) }, bundle.snapshot, bundle.coefficientSet);
  const option = priced.options.find((o) => o.tier === tier);
  if (!option) return { ok: false, status: 409, error: 'no_option', message: 'That option is not offered on this estimate.' };
  if (Math.abs(option.price - price) > 0.005) {
    return { ok: false, status: 409, error: 'pricing_changed', message: 'The price on the office copy is different. Sync the estimate, then ask again.' };
  }
  const problem = canSendQuote(role, priced.options, bundle.snapshot.settings).problems.find(
    (p) => p.tier === tier && (p.kind === 'below_floor' || p.kind === 'over_limit'),
  );
  if (!problem || problem.price === undefined || problem.modelPrice === undefined) {
    return { ok: false, status: 400, error: 'not_needed', message: 'This price needs no approval: you can send it yourself.' };
  }
  return { ok: true, problem: { ...problem, price: problem.price, modelPrice: problem.modelPrice } };
}

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
