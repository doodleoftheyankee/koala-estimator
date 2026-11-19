// The prices waiting for a decision (L34): on the office Estimates page, for the owner and the office.
// Each request names the customer, the option, the price asked against the model price, who asked
// and why; Approve and Decline call PATCH /api/approvals/[id]. The database decides who may decide
// (never your own request; below the floor margin, the owner only); this list only offers the
// buttons where the answer would be yes.
import Link from 'next/link';
import { z } from 'zod';
import { Card, SignLabel, Tag } from '@/components/daymark';
import { formatDateTime, formatMoney, TIER_LABELS } from '@/lib/format';
import type { Role } from '@/lib/pricing';
import { APPROVAL_COLUMNS, approvalFromRow, isLiveRequest } from '@/lib/quotes/approvals';
import type { createClient } from '@/lib/supabase/server';
import { DecideButtons } from './DecideButtons';

type Db = Awaited<ReturnType<typeof createClient>>;

const one = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (Array.isArray(v) ? (v[0] ?? null) : v), schema.nullable().optional());
const contextSchema = z.object({
  estimate: one(
    z.object({
      id: z.string(),
      customer: one(z.object({ first_name: z.string(), last_name: z.string() })),
      property: one(z.object({ street: z.string(), city: z.string() })),
    }),
  ),
  requester: one(z.object({ full_name: z.string() })),
});

export interface QueueItem {
  id: string;
  estimateId: string;
  customer: string;
  address: string | null;
  tier: keyof typeof TIER_LABELS;
  price: number;
  modelPrice: number;
  belowFloor: boolean;
  requester: string;
  requestedBy: string | null;
  requestedAt: string;
  note: string | null;
}

/**
 * The requests waiting for a decision, oldest first. Null when they cannot be read. A request whose
 * estimate is signed, lost or void, or whose option has another price (or a higher cost) now, is no
 * longer a question and is left out (review B flow-B3: lib/quotes/approvals.ts isLiveRequest).
 */
export async function loadQueue(db: Db): Promise<QueueItem[] | null> {
  const { data, error } = await db
    .from('price_approvals')
    .select(
      `${APPROVAL_COLUMNS},
       estimate:estimates(id, status, options:estimate_options(tier, price, loaded_cost), customer:customers(first_name, last_name), property:properties(street, city)),
       requester:profiles!price_approvals_requested_by_fkey(full_name)`,
    )
    .eq('status', 'pending')
    .order('requested_at', { ascending: true })
    // Stale requests are read and left out below, so read more than the list ever shows.
    .limit(200);
  if (error) return null;
  const out: QueueItem[] = [];
  for (const row of (data ?? []) as unknown[]) {
    const a = approvalFromRow(row);
    const ctx = contextSchema.safeParse(row);
    if (!a || !ctx.success || !isLiveRequest(row)) continue;
    const c = ctx.data;
    const name = c.estimate?.customer ? `${c.estimate.customer.first_name} ${c.estimate.customer.last_name}`.trim() : '';
    const address = c.estimate?.property ? [c.estimate.property.street, c.estimate.property.city].filter((s) => s.trim()).join(', ') : '';
    out.push({
      id: a.id,
      estimateId: a.estimateId,
      customer: name || 'New customer',
      address: address || null,
      tier: a.tier,
      price: a.price,
      modelPrice: a.modelPrice,
      belowFloor: a.belowFloor,
      requester: c.requester?.full_name ?? 'An estimator',
      requestedBy: a.requestedBy ?? null,
      requestedAt: a.requestedAt ?? '',
      note: a.note ?? null,
    });
  }
  return out;
}

/** "17% below the model price of $5,420". */
function againstModel(price: number, model: number): string {
  if (!(model > 0)) return 'no model price';
  const d = (price - model) / model;
  if (Math.abs(d) < 0.005) return `the model price of ${formatMoney(model)}`;
  return `${Math.round(Math.abs(d) * 100)}% ${d < 0 ? 'below' : 'above'} the model price of ${formatMoney(model)}`;
}

export function ApprovalQueue({ items, role, userId }: { items: QueueItem[]; role: Role; userId: string }) {
  if (items.length === 0) return null;
  return (
    <Card aria-labelledby="approvals-title" className="space-y-3">
      <div>
        <SignLabel tone="ink" size={12}>
          Needs you
        </SignLabel>
        <h2 id="approvals-title" className="mt-1 text-[22px] leading-tight font-extrabold text-ink">
          {items.length === 1 ? '1 price waiting for approval' : `${items.length} prices waiting for approval`}
        </h2>
        <p className="mt-1 text-[15px] font-medium text-ink-2">An estimator asked to send these prices. Approve one and they can send it at exactly that price.</p>
      </div>
      <ul className="divide-y divide-solid divide-line" aria-label="Prices waiting for approval">
        {items.map((it) => {
          const own = it.requestedBy === userId;
          const ownerOnly = it.belowFloor && role !== 'owner';
          return (
            <li key={it.id} className="space-y-2 py-3" data-approval={it.id}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link href={`/field?e=${encodeURIComponent(it.estimateId)}`} prefetch={false} className="text-[18px] font-bold text-ink underline-offset-2 hover:underline">
                    {it.customer}
                  </Link>
                  {it.address ? <p className="text-[15px] font-medium text-ink-2">{it.address}</p> : null}
                </div>
                {it.belowFloor ? <Tag tone="warn">Below the floor margin</Tag> : null}
              </div>
              <p className="text-[17px] font-semibold text-ink">
                {TIER_LABELS[it.tier]}: <span className="gauge-m">{formatMoney(it.price)}</span>, {againstModel(it.price, it.modelPrice)}
              </p>
              <p className="text-[15px] font-medium text-ink-2">
                Asked by {it.requester} · {formatDateTime(it.requestedAt)}
                {it.note ? ` · “${it.note}”` : ''}
              </p>
              {own ? (
                <p className="text-[15px] font-medium text-ink-2">You asked for this price, so someone else decides it.</p>
              ) : ownerOnly ? (
                <p className="text-[15px] font-medium text-ink-2">Only the owner can decide a price below the floor margin.</p>
              ) : (
                <DecideButtons id={it.id} label={`${TIER_LABELS[it.tier]} at ${formatMoney(it.price)} for ${it.customer}`} />
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
