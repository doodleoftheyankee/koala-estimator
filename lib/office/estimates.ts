// The office estimates list (/estimates): what each row says and what the figures at the top
// count. Pure, so every figure on the page comes from the rows the page lists:
//
//  - Status: the one quote vocabulary (Draft, Sent, Viewed, Signed, Declined, Expired, Lost),
//    plus Void for an estimate the office voided. The estimate's own status is the authority,
//    as on the estimator's phone (lib/field/estimateList.ts); the latest quote only adds what the
//    estimate does not carry (the customer opened it, or it was closed as declined). "Ready"
//    (complete, not sent yet) shows as Draft.
//  - Price: the same headline price the field app shows. A signed quote's signed price; otherwise
//    the price of the option the estimator recommended (selected), else Better, else the first
//    option. Nothing is re-priced here: every figure is a price the server already stored.
//  - Figures: each tile says exactly what it counts, and lost, declined, expired and void rows
//    are never in a money total.
import { formatShortDateTime, TIER_LABELS } from '@/lib/format';
import { TIERS, type Tier } from '@/lib/pricing';
import { ESTIMATE_STATUSES } from '@/lib/sync/draft';
import { moneyGroup, type MoneyGroup } from './figures';

export { ESTIMATE_STATUSES };
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

/** What a row's badge says. */
export type RowStatus = 'draft' | 'sent' | 'viewed' | 'signed' | 'declined' | 'expired' | 'lost' | 'void';

export interface LatestQuote {
  id: string;
  version: number;
  status: string;
  sentAt: string | null;
  signedAt: string | null;
  signedPrice: number | null;
}

export function isEstimateStatus(s: unknown): s is EstimateStatus {
  return typeof s === 'string' && (ESTIMATE_STATUSES as readonly string[]).includes(s);
}

/** The badge for an estimate, from its status and its latest quote. */
export function rowStatus(status: EstimateStatus, quote: Pick<LatestQuote, 'status'> | null): RowStatus {
  switch (status) {
    case 'lost':
    case 'void':
    case 'signed':
    case 'expired':
      return status;
    case 'sent':
    case 'viewed':
      if (quote?.status === 'signed') return 'signed';
      if (quote?.status === 'declined') return 'declined';
      if (quote?.status === 'expired') return 'expired';
      if (quote?.status === 'viewed') return 'viewed';
      return status;
    case 'draft':
    case 'ready':
      // Signed on the server but the estimate row not updated (should not happen): trust the signature.
      return quote?.status === 'signed' ? 'signed' : 'draft';
  }
}

/**
 * The `?status=` filter as the database query uses it. Draft also finds "ready" estimates,
 * because both show as Draft; every other value filters exactly as before.
 */
export function statusFilterValues(status: EstimateStatus): EstimateStatus[] {
  return status === 'draft' ? ['draft', 'ready'] : [status];
}

const isTier = (t: unknown): t is Tier => typeof t === 'string' && (TIERS as readonly string[]).includes(t);
const isPrice = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export interface HeadlinePrice {
  price: number | null;
  /** Which option the price belongs to, when known. */
  tier: Tier | null;
  /** The price the customer signed for. */
  signed: boolean;
}

/**
 * The row's headline price, chosen the way the field app chooses it (app/field/EstimateEditor.tsx
 * summaryPrice): the signed price, else the selected option, else Better, else the first option
 * (Good, Better, Best order). `modelTotalPrice` is only a last resort for rows saved without
 * options.
 */
export function headlinePrice(args: {
  selectedTier: string | null;
  options: ReadonlyArray<{ tier: string; price: number | null }> | null | undefined;
  modelTotalPrice: number | null;
  signedPrice: number | null;
}): HeadlinePrice {
  const selected = isTier(args.selectedTier) ? args.selectedTier : null;
  if (isPrice(args.signedPrice)) return { price: args.signedPrice, tier: selected, signed: true };
  const options = (args.options ?? [])
    .filter((o): o is { tier: Tier; price: number } => isTier(o.tier) && isPrice(o.price))
    .sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier));
  const pick = options.find((o) => o.tier === selected) ?? options.find((o) => o.tier === 'better') ?? options[0];
  if (pick) return { price: pick.price, tier: pick.tier, signed: false };
  return { price: isPrice(args.modelTotalPrice) ? args.modelTotalPrice : null, tier: null, signed: false };
}

/** What the price is, in words under the number ("Better", "Signed, Best"). */
export function priceLabel(p: HeadlinePrice): string | null {
  if (p.price === null) return null;
  const tier = p.tier ? TIER_LABELS[p.tier] : null;
  if (p.signed) return tier ? `Signed, ${tier}` : 'Signed';
  return tier ?? 'Recommended';
}

/** One line of what last happened to the estimate. */
export function activityLine(status: RowStatus, quote: LatestQuote | null, lostReason: string | null): string | null {
  const v = quote ? `Quote v${quote.version}` : null;
  switch (status) {
    case 'lost':
      return lostReason?.trim() ? `Lost: ${lostReason.trim()}` : 'Marked lost';
    case 'void':
      return null;
    case 'signed':
      return quote?.signedAt ? `Signed ${formatShortDateTime(quote.signedAt)}` : v ? `${v} signed` : null;
    case 'declined':
      return v ? `${v} declined` : null;
    case 'expired':
      return v ? `${v} expired` : 'Price hold ran out';
    case 'sent':
    case 'viewed':
      if (!v) return null;
      return quote?.sentAt ? `${v} sent ${formatShortDateTime(quote.sentAt)}` : `${v} sent`;
    case 'draft':
      return v ? `Changed after quote v${quote!.version} was sent` : 'Not sent yet';
  }
}

/** Which figure over the list a row counts under. */
export type KpiGroup = 'waiting' | 'signed' | 'drafts' | 'closed';

export function kpiGroup(status: RowStatus): KpiGroup {
  if (status === 'sent' || status === 'viewed') return 'waiting';
  if (status === 'signed') return 'signed';
  if (status === 'draft') return 'drafts';
  return 'closed';
}

export interface EstimateKpis {
  /** Sent or Viewed: quotes the customer can still sign. */
  waiting: MoneyGroup;
  signed: MoneyGroup;
  /** Draft (and ready): not sent yet. */
  drafts: MoneyGroup;
  /** Lost, declined, expired and void: counted, never in a money total. */
  closed: { count: number; lost: number; declined: number; expired: number; void: number };
}

/** The figures over the list, from exactly the rows the list shows. */
export function estimateKpis(rows: ReadonlyArray<{ status: RowStatus; price: number | null }>): EstimateKpis {
  const by = (g: KpiGroup) => rows.filter((r) => kpiGroup(r.status) === g);
  const closed = by('closed');
  const n = (s: RowStatus) => closed.filter((r) => r.status === s).length;
  return {
    waiting: moneyGroup(by('waiting')),
    signed: moneyGroup(by('signed')),
    drafts: moneyGroup(by('drafts')),
    closed: { count: closed.length, lost: n('lost'), declined: n('declined'), expired: n('expired'), void: n('void') },
  };
}

/** "2 lost and 1 expired": what the closed tile counts, in words. Null when there are none. */
export function closedWords(c: EstimateKpis['closed']): string | null {
  const parts = [
    c.lost ? `${c.lost} lost` : null,
    c.declined ? `${c.declined} declined` : null,
    c.expired ? `${c.expired} expired` : null,
    c.void ? `${c.void} void` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

const CHIP_LABELS: Record<EstimateStatus, string> = {
  draft: 'Draft',
  ready: 'Ready to send',
  sent: 'Sent',
  viewed: 'Viewed',
  signed: 'Signed',
  lost: 'Lost',
  expired: 'Expired',
  void: 'Void',
};

/** The everyday status filters, in lifecycle order. */
const EVERYDAY: readonly EstimateStatus[] = ['draft', 'sent', 'viewed', 'signed', 'lost', 'expired'];

/**
 * The status filter chips: All, then one per badge an office person filters by. A status that
 * only an old link or bookmark still asks for (ready, void) gets its own chip while it is chosen,
 * so the page always says what it is showing.
 */
export function statusChips(current: EstimateStatus | null): Array<{ value: EstimateStatus | null; label: string; current: boolean }> {
  const values: Array<EstimateStatus | null> = [null, ...EVERYDAY];
  if (current && !EVERYDAY.includes(current)) values.push(current);
  return values.map((v) => ({ value: v, label: v ? CHIP_LABELS[v] : 'All', current: v === current }));
}

/** A /estimates link with these filters (empty ones left out), so chips keep each other's choice. */
export function estimatesHref(f: { status: string | null; estimator: string | null }): string {
  const q = new URLSearchParams();
  if (f.status) q.set('status', f.status);
  if (f.estimator) q.set('estimator', f.estimator);
  const s = q.toString();
  return s ? `/estimates?${s}` : '/estimates';
}
