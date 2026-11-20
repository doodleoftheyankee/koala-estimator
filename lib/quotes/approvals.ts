// Price approvals (table price_approvals, L34): reading them for one estimate, for the queue, and
// the latest request per option for the phone's Send checklist. The rules about who may ask and who
// may decide live in the database (RLS) and lib/pricing/policy.ts (which approvals let a price through).
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { TIERS, type PriceApproval, type Role, type Tier } from '@/lib/pricing';

/** The columns every reader selects. */
export const APPROVAL_COLUMNS =
  'id, estimate_id, tier, price, model_price, below_floor, loaded_cost, status, decided_role, note, decision_note, requested_at, requested_by, decided_at';

const numeric = z.union([z.number(), z.string()]).transform((v) => Number(v));
const ROLES = ['owner', 'office', 'estimator', 'crew'] as const;

export const approvalRowSchema = z.object({
  id: z.string(),
  estimate_id: z.string(),
  tier: z.enum(TIERS),
  price: numeric,
  model_price: numeric,
  below_floor: z.boolean(),
  /** The loaded cost it was asked at (review B database-B2); null on a row recorded without it. */
  loaded_cost: numeric.nullable().optional(),
  status: z.enum(['pending', 'approved', 'declined']),
  decided_role: z.enum(ROLES).nullable(),
  note: z.string().nullable().optional(),
  decision_note: z.string().nullable().optional(),
  requested_at: z.string(),
  requested_by: z.string().optional(),
  decided_at: z.string().nullable().optional(),
});
export type ApprovalRow = z.input<typeof approvalRowSchema>;

export function approvalFromRow(row: unknown): PriceApproval | null {
  const r = approvalRowSchema.safeParse(row);
  if (!r.success) return null;
  const d = r.data;
  return {
    id: d.id,
    estimateId: d.estimate_id,
    tier: d.tier,
    price: d.price,
    modelPrice: d.model_price,
    belowFloor: d.below_floor,
    status: d.status,
    decidedRole: d.decided_role as Role | null,
    note: d.note ?? null,
    decisionNote: d.decision_note ?? null,
    requestedAt: d.requested_at,
    requestedBy: d.requested_by,
    decidedAt: d.decided_at ?? null,
    loadedCost: d.loaded_cost ?? null,
  };
}

export function approvalsFromRows(rows: unknown): PriceApproval[] {
  return Array.isArray(rows) ? rows.map(approvalFromRow).filter((a): a is PriceApproval => a !== null) : [];
}

/** An estimate's approvals, newest first, as the signed-in user may read them (RLS). */
export async function loadApprovals(db: SupabaseClient, estimateId: string): Promise<PriceApproval[]> {
  const { data, error } = await db.from('price_approvals').select(APPROVAL_COLUMNS).eq('estimate_id', estimateId).order('requested_at', { ascending: false });
  if (error) throw new Error(`Reading price approvals failed: ${error.message}`);
  return approvalsFromRows(data);
}

/** The approved prices by option: what the estimate may be sent at beyond the estimator's own range. */
export function approvedPrices(approvals: readonly PriceApproval[]): Partial<Record<Tier, number[]>> {
  const out: Partial<Record<Tier, number[]>> = {};
  for (const a of approvals) if (a.status === 'approved') (out[a.tier] ??= []).push(a.price);
  return out;
}

/**
 * The newest request for each option at the price (and model price) it has now: what the phone shows
 * next to that option (waiting, approved or declined). A request for another price, or asked against
 * another model price, is an older question and does not count; nor is one asked at a lower loaded
 * cost than the option has now (review B database-B2: line changes since raised it), so the phone
 * offers Request approval again.
 */
export function latestByTier(
  approvals: readonly PriceApproval[],
  current: Partial<Record<Tier, { price: number; modelPrice: number; loadedCost?: number }>> = {},
): Partial<Record<Tier, PriceApproval>> {
  const out: Partial<Record<Tier, PriceApproval>> = {};
  const newestFirst = [...approvals].sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));
  for (const a of newestFirst) {
    const now = current[a.tier];
    if (now && (Math.abs(now.price - a.price) > 0.005 || Math.abs(now.modelPrice - a.modelPrice) > 0.005)) continue;
    if (now?.loadedCost !== undefined && (a.loadedCost === null || a.loadedCost === undefined || now.loadedCost > a.loadedCost + 0.005)) continue;
    if (!out[a.tier]) out[a.tier] = a;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The owner's queue (review B flow-B3)
// ---------------------------------------------------------------------------

/** Estimates whose requests nobody needs to decide: signed (locked), lost or void. */
const CLOSED_ESTIMATE = new Set(['signed', 'lost', 'void']);

const queueEstimateSchema = z.object({
  status: z.string(),
  options: z.array(z.object({ tier: z.string(), price: numeric, loaded_cost: numeric.nullable().optional() })).nullable().optional(),
});

/**
 * Is a waiting request still a real question? Not when its estimate is signed, lost or void, nor when
 * the option it is about is gone, has another price now, or costs more than when it was asked (an
 * approval would not cover it: lib/pricing/policy.ts approvalCovers). `row` is a price_approvals row
 * with its estimate (status) and the estimate's current options (tier, price, loaded_cost).
 */
export function isLiveRequest(row: unknown): boolean {
  const a = approvalFromRow(row);
  const raw = (row as { estimate?: unknown } | null)?.estimate;
  const est = queueEstimateSchema.safeParse(Array.isArray(raw) ? raw[0] : raw);
  if (!a || !est.success || CLOSED_ESTIMATE.has(est.data.status)) return false;
  const option = (est.data.options ?? []).find((o) => o.tier === a.tier);
  if (!option || Math.abs(option.price - a.price) > 0.005) return false;
  if (option.loaded_cost !== null && option.loaded_cost !== undefined && a.loadedCost !== null && a.loadedCost !== undefined && option.loaded_cost > a.loadedCost + 0.005) return false;
  return true;
}

export interface DecisionRefusal {
  status: number;
  error: string;
  message: string;
}

/**
 * Why a decision on this request is refused, in words, or null when it may go ahead (the database
 * enforces the same rules). A request on an estimate the customer signed is never decided (flow-B3).
 */
export function decisionRefusal(args: { approval: PriceApproval; estimateStatus: string | null; role: Role; userId: string }): DecisionRefusal | null {
  const { approval, estimateStatus, role, userId } = args;
  if (estimateStatus === null) return { status: 404, error: 'not_found', message: 'Request not found.' };
  if (estimateStatus === 'signed') return { status: 409, error: 'signed', message: 'The customer already signed this quote.' };
  if (approval.status !== 'pending') return { status: 409, error: 'decided', message: `This request was already ${approval.status}.` };
  if (approval.requestedBy === userId) return { status: 403, error: 'own_request', message: 'You asked for this price, so someone else decides it.' };
  if (approval.belowFloor && role !== 'owner') return { status: 403, error: 'owner_only', message: 'Only the owner can decide a price below the floor margin.' };
  return null;
}
