// Price approvals (table price_approvals, L34): reading them for one estimate, for the queue, and
// the latest request per option for the phone's Send checklist. The rules about who may ask and who
// may decide live in the database (RLS) and lib/pricing/policy.ts (which approvals let a price through).
import { z } from 'zod';
import { TIERS, type PriceApproval, type Role, type Tier } from '@/lib/pricing';

/** The columns every reader selects. */
export const APPROVAL_COLUMNS =
  'id, estimate_id, tier, price, model_price, below_floor, status, decided_role, note, decision_note, requested_at, requested_by, decided_at';

const numeric = z.union([z.number(), z.string()]).transform((v) => Number(v));
const ROLES = ['owner', 'office', 'estimator', 'crew'] as const;

export const approvalRowSchema = z.object({
  id: z.string(),
  estimate_id: z.string(),
  tier: z.enum(TIERS),
  price: numeric,
  model_price: numeric,
  below_floor: z.boolean(),
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
  };
}

export function approvalsFromRows(rows: unknown): PriceApproval[] {
  return Array.isArray(rows) ? rows.map(approvalFromRow).filter((a): a is PriceApproval => a !== null) : [];
}

interface Reader {
  from: (table: 'price_approvals') => {
    select: (cols: string) => {
      eq: (col: 'estimate_id', v: string) => { order: (col: 'requested_at', o: { ascending: boolean }) => PromiseLike<{ data: unknown; error: { message: string } | null }> };
    };
  };
}

/** An estimate's approvals, newest first, as the signed-in user may read them (RLS). */
export async function loadApprovals(db: Reader, estimateId: string): Promise<PriceApproval[]> {
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
 * another model price, is an older question and does not count.
 */
export function latestByTier(
  approvals: readonly PriceApproval[],
  current: Partial<Record<Tier, { price: number; modelPrice: number }>> = {},
): Partial<Record<Tier, PriceApproval>> {
  const out: Partial<Record<Tier, PriceApproval>> = {};
  const newestFirst = [...approvals].sort((a, b) => (b.requestedAt ?? '').localeCompare(a.requestedAt ?? ''));
  for (const a of newestFirst) {
    const now = current[a.tier];
    if (now && (Math.abs(now.price - a.price) > 0.005 || Math.abs(now.modelPrice - a.modelPrice) > 0.005)) continue;
    if (!out[a.tier]) out[a.tier] = a;
  }
  return out;
}
