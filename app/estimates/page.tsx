import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';
import { Ban, Banner, Button, ButtonLink, Download, EmptyState, Field, FileText, Icon, Plus, Search, Select, StatusBadge, Tag } from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { ABOVE_ROW_LINK, FilterChips, KpiStrip, ROW_LINK, TABLE, type KpiItem } from '@/components/office';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { formatDateTime, formatMoney, plural, relativeTime } from '@/lib/format';
import { canMarkLost } from '@/lib/jobs/forms';
import {
  activityLine,
  closedWords,
  ESTIMATE_STATUSES,
  estimateKpis,
  estimatesHref,
  headlinePrice,
  priceLabel,
  rowStatus,
  statusChips,
  statusFilterValues,
  type EstimateKpis,
  type LatestQuote,
  type RowStatus,
} from '@/lib/office/estimates';
import type { MoneyGroup } from '@/lib/office/figures';
import { RowMenu } from './RowMenu';

export const metadata: Metadata = { title: 'Estimates' };

/** The list shows at most this many estimates, newest change first. */
const LIMIT = 200;
/** More estimators than this and the estimator filter is a drop-down, not chips. */
const MAX_ESTIMATOR_CHIPS = 8;

// ---------------------------------------------------------------------------
// Row parsing (embedded to-one relations may come back as an object or a 1-item array)
// ---------------------------------------------------------------------------

const one = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (Array.isArray(v) ? (v[0] ?? null) : v), schema.nullable().optional());
const money = z
  .union([z.number(), z.string()])
  .nullable()
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)));

const rowSchema = z.object({
  id: z.string(),
  status: z.enum(ESTIMATE_STATUSES),
  updated_at: z.string(),
  selected_tier: z.string().nullable(),
  model_total_price: money,
  lost_reason: z.string().nullable().optional(),
  customer: one(z.object({ first_name: z.string(), last_name: z.string() })),
  property: one(z.object({ street: z.string(), city: z.string() })),
  estimator: one(z.object({ full_name: z.string() })),
  options: z.array(z.object({ tier: z.string(), price: money })).nullable().optional(),
  quotes: z
    .array(
      z.object({
        id: z.string(),
        version: z.coerce.number(),
        status: z.string(),
        sent_at: z.string().nullable(),
        signed_at: z.string().nullable(),
        signed_price: money,
      }),
    )
    .nullable()
    .optional(),
});
type Row = z.infer<typeof rowSchema>;

const estimatorSchema = z.array(z.object({ id: z.string(), full_name: z.string() }));

interface Item {
  id: string;
  status: RowStatus;
  customer: string;
  address: string | null;
  estimator: string;
  price: number | null;
  priceLabel: string | null;
  activity: string | null;
  updatedAt: string;
  openHref: string;
  pdfHref: string | null;
  quoteVersion: number | null;
  openQuoteVersion: number | null;
  canMarkLost: boolean;
}

function toItem(r: Row): Item {
  const q = r.quotes?.[0];
  const quote: LatestQuote | null = q
    ? { id: q.id, version: q.version, status: q.status, sentAt: q.sent_at, signedAt: q.signed_at, signedPrice: q.signed_price }
    : null;
  const status = rowStatus(r.status, quote);
  const head = headlinePrice({
    selectedTier: r.selected_tier,
    options: r.options,
    modelTotalPrice: r.model_total_price,
    signedPrice: quote?.status === 'signed' || r.status === 'signed' ? (quote?.signedPrice ?? null) : null,
  });
  const name = r.customer ? `${r.customer.first_name} ${r.customer.last_name}`.trim() : '';
  return {
    id: r.id,
    status,
    customer: name || 'Customer not named yet',
    address: r.property ? [r.property.street, r.property.city].filter((s) => s.trim()).join(', ') || null : null,
    estimator: r.estimator?.full_name ?? '—',
    price: head.price,
    priceLabel: priceLabel(head),
    activity: activityLine(status, quote, r.status === 'lost' ? (r.lost_reason ?? null) : null),
    updatedAt: r.updated_at,
    openHref: `/field?e=${encodeURIComponent(r.id)}`,
    pdfHref: quote ? `/api/quotes/${encodeURIComponent(quote.id)}/pdf` : null,
    quoteVersion: quote?.version ?? null,
    openQuoteVersion: quote && (quote.status === 'sent' || quote.status === 'viewed') ? quote.version : null,
    canMarkLost: canMarkLost(r.status),
  };
}

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function EstimatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const profile = await requireRole('owner', 'office', 'estimator');
  const canFilterEstimator = profile.role === 'owner' || profile.role === 'office';
  const sp = await searchParams;

  const statusParam = firstParam(sp.status);
  const status = ESTIMATE_STATUSES.find((s) => s === statusParam) ?? null;
  const estimatorParam = firstParam(sp.estimator);
  const estimatorId = canFilterEstimator && estimatorParam && z.guid().safeParse(estimatorParam).success ? estimatorParam : null;

  const db = await createClient();
  let query = db
    .from('estimates')
    .select(
      `id, status, updated_at, selected_tier, model_total_price, lost_reason,
       customer:customers(first_name, last_name),
       property:properties(street, city),
       estimator:profiles!estimates_estimator_id_fkey(full_name),
       options:estimate_options(tier, price),
       quotes(id, version, status, sent_at, signed_at, signed_price)`,
    )
    .order('updated_at', { ascending: false })
    .order('version', { referencedTable: 'quotes', ascending: false })
    .limit(1, { referencedTable: 'quotes' })
    .limit(LIMIT);
  if (status) query = query.in('status', statusFilterValues(status));
  if (estimatorId) query = query.eq('estimator_id', estimatorId);

  const [res, estimatorsRes] = await Promise.all([
    query,
    canFilterEstimator
      ? db.from('profiles').select('id, full_name').in('role', ['owner', 'office', 'estimator']).order('full_name')
      : Promise.resolve(null),
  ]);

  let rows: Row[] = [];
  let error: string | null = null;
  if (res.error) error = res.error.message;
  else {
    const parsed = z.array(rowSchema).safeParse(res.data);
    if (parsed.success) rows = parsed.data;
    else error = `Unexpected data from the server (${parsed.error.issues[0]?.message ?? 'parse error'}).`;
  }
  const estimators = estimatorsRes && !estimatorsRes.error ? (estimatorSchema.safeParse(estimatorsRes.data).data ?? []) : [];

  const items = rows.map(toItem);
  const now = new Date().getTime();
  const kpis = estimateKpis(items);
  const filtered = Boolean(status || estimatorId);
  const capped = items.length === LIMIT;
  const estimatorName = estimatorId ? (estimators.find((e) => e.id === estimatorId)?.full_name ?? 'one estimator') : null;
  const title = profile.role === 'estimator' ? 'All my estimates' : 'Estimates';

  return (
    <main className="@container mx-auto max-w-6xl space-y-6 px-4 py-6 md:px-6">
      <PageHeader
        title={title}
        description={profile.role === 'estimator' ? 'Every estimate you have synced, newest change first.' : 'Every estimate and quote, newest change first.'}
        actions={
          <ButtonLink href="/field?new=1" variant="primary" icon={Plus} prefetch={false}>
            New estimate
          </ButtonLink>
        }
      />

      {!error && items.length > 0 ? (
        <KpiStrip
          title="Figures for this list"
          items={kpiItems(kpis)}
          note={countNote(items.length, { capped, filtered, statusLabel: status ? statusChips(status).find((c) => c.current)?.label : null, estimatorName })}
        />
      ) : null}

      <div className="space-y-4">
        <FilterChips
          label="Status"
          items={statusChips(status).map((c) => ({
            key: c.value ?? 'all',
            label: c.label,
            current: c.current,
            href: estimatesHref({ status: c.value, estimator: estimatorId }),
          }))}
        />
        {canFilterEstimator && estimators.length > 0 ? (
          estimators.length <= MAX_ESTIMATOR_CHIPS ? (
            <FilterChips
              label="Estimator"
              items={[
                { key: 'everyone', label: 'Everyone', current: estimatorId === null, href: estimatesHref({ status, estimator: null }) },
                ...estimators.map((e) => ({ key: e.id, label: e.full_name, current: e.id === estimatorId, href: estimatesHref({ status, estimator: e.id }) })),
              ]}
            />
          ) : (
            <EstimatorPicker estimators={estimators} current={estimatorId} status={status} />
          )
        ) : null}
      </div>

      {error ? (
        <Banner
          tone="bad"
          title="Could not load estimates"
          action={
            <ButtonLink href={estimatesHref({ status, estimator: estimatorId })} size="sm" prefetch={false}>
              Try again
            </ButtonLink>
          }
        >
          {error}
        </Banner>
      ) : null}

      {!error && items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon={Search}
            title="No estimates match these filters"
            hint="Try another status, or show every estimate."
            action={
              <ButtonLink href="/estimates" prefetch={false}>
                Clear filters
              </ButtonLink>
            }
          />
        ) : (
          <EmptyState
            icon={FileText}
            title="No estimates yet"
            hint={
              profile.role === 'estimator'
                ? 'Estimates appear here once your phone syncs them. Start one with New estimate.'
                : 'Estimates appear here once an estimator’s phone syncs them. Start one with New estimate.'
            }
          />
        )
      ) : null}

      {items.length ? (
        <>
          {/* Narrow screens: one plate, a block per estimate. */}
          <ul aria-label={title} className="plate divide-y divide-solid divide-line @4xl:hidden">
            {items.map((it) => (
              <li key={it.id} className="relative px-4 py-3.5 hover:bg-sunken">
                <EstimateCard item={it} showEstimator={canFilterEstimator} now={now} />
              </li>
            ))}
          </ul>

          {/* Wide screens: a hairline table. */}
          <div className={`${TABLE.plate} hidden @4xl:block`}>
            <table className={`${TABLE.table} table-fixed`}>
              <caption className="sr-only">{title}</caption>
              <colgroup>
                <col />
                <col />
                <col className="w-40" />
                {canFilterEstimator ? <col className="w-32" /> : null}
                <col className="w-28" />
                <col className="w-36" />
              </colgroup>
              <thead>
                <tr className={TABLE.headRow}>
                  <th scope="col" className={TABLE.th}>
                    Customer
                  </th>
                  <th scope="col" className={TABLE.th}>
                    Status
                  </th>
                  <th scope="col" className={`${TABLE.th} ${TABLE.thNum} pr-6`}>
                    Price
                  </th>
                  {canFilterEstimator ? (
                    <th scope="col" className={TABLE.th}>
                      Estimator
                    </th>
                  ) : null}
                  <th scope="col" className={TABLE.th}>
                    Updated
                  </th>
                  <th scope="col" className={TABLE.th}>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className={TABLE.body}>
                {items.map((it) => (
                  <tr key={it.id} className={TABLE.row}>
                    <td className={TABLE.td}>
                      <Link href={it.openHref} prefetch={false} className={ROW_LINK}>
                        {it.customer}
                      </Link>
                      {it.address ? <p className="mt-0.5 text-[15px] font-medium text-ink-2">{it.address}</p> : null}
                    </td>
                    <td className={TABLE.td}>
                      <Badge status={it.status} />
                      {it.activity ? <p className="mt-1.5 text-[15px] leading-snug font-medium text-ink-2 [overflow-wrap:anywhere]">{it.activity}</p> : null}
                    </td>
                    <td className={`${TABLE.td} ${TABLE.tdNum} pr-6`}>
                      <Price price={it.price} label={it.priceLabel} />
                    </td>
                    {canFilterEstimator ? <td className={`${TABLE.td} text-ink-2`}>{it.estimator}</td> : null}
                    <td className={`${TABLE.td} text-[15px] font-medium text-ink-2`}>
                      <Updated at={it.updatedAt} now={now} />
                    </td>
                    <td className={`${TABLE.td} py-2 pr-2 pl-1`}>
                      <RowActions item={it} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {capped ? <p className="text-[15px] font-medium text-ink-3">Showing the {LIMIT} most recent. Use the filters to narrow down.</p> : null}
        </>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

function moneyLine(g: MoneyGroup, noun: string, what: string): string {
  const base = `${plural(g.count, noun)}, ${what}`;
  if (g.unpriced === 0) return base;
  return `${base}. ${g.unpriced} without a price ${g.unpriced === 1 ? 'is' : 'are'} not in the total`;
}

function kpiItems(k: EstimateKpis): KpiItem[] {
  return [
    {
      key: 'waiting',
      label: 'Waiting to sign',
      value: formatMoney(k.waiting.total ?? 0),
      detail: moneyLine(k.waiting, 'quote', 'sent or viewed'),
    },
    {
      key: 'signed',
      label: 'Signed',
      value: formatMoney(k.signed.total ?? 0),
      detail: moneyLine(k.signed, 'quote', 'signed by the customer'),
    },
    {
      key: 'drafts',
      label: 'Drafts',
      value: String(k.drafts.count),
      detail: `${k.drafts.count === 1 ? 'estimate' : 'estimates'} not sent yet`,
    },
    {
      key: 'closed',
      label: 'Lost or expired',
      value: String(k.closed.count),
      detail: closedWords(k.closed) ? `${closedWords(k.closed)}. Not in any total` : 'Lost, declined or expired. Not in any total',
    },
  ];
}

function countNote(
  n: number,
  f: { capped: boolean; filtered: boolean; statusLabel: string | null | undefined; estimatorName: string | null },
): string {
  const which = [f.statusLabel ? `status ${f.statusLabel}` : null, f.estimatorName ? `estimator ${f.estimatorName}` : null].filter(Boolean).join(', ');
  const rows = f.capped ? `the ${n} most recent estimates` : `the ${plural(n, 'estimate')}`;
  return `These figures count ${rows} listed below${f.filtered && which ? ` (${which})` : ''}.`;
}

// ---------------------------------------------------------------------------
// Row parts
// ---------------------------------------------------------------------------

function Badge({ status }: { status: RowStatus }) {
  if (status === 'void') {
    return (
      <Tag tone="draft" icon={Ban}>
        Void
      </Tag>
    );
  }
  return <StatusBadge status={status} />;
}

function Price({ price, label }: { price: number | null; label: string | null }) {
  if (price === null) return <span className="text-[15px] font-semibold text-ink-3">No price yet</span>;
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="gauge-m text-[22px] text-ink">{formatMoney(price)}</span>
      {label ? <span className="sign-label text-ink-2 [--sign-size:11px]">{label}</span> : null}
    </span>
  );
}

/** When the estimate last changed: relative in the list, the full date on hover (UX-10). */
function Updated({ at, now }: { at: string; now: number }) {
  return (
    <time dateTime={at} title={formatDateTime(at)}>
      {relativeTime(at, now)}
    </time>
  );
}

function RowActions({ item }: { item: Item }) {
  return (
    <div className={`${ABOVE_ROW_LINK} flex items-center justify-end gap-1`}>
      {item.pdfHref ? (
        <a
          href={item.pdfHref}
          target="_blank"
          rel="noopener"
          aria-label={`PDF of quote v${item.quoteVersion} for ${item.customer}`}
          className="inline-flex min-h-12 items-center gap-1.5 rounded-control px-3 text-[16px] font-bold text-ink no-underline hover:bg-sunken hover:underline"
        >
          <Icon icon={Download} size="s" className="text-ink-2" />
          PDF
        </a>
      ) : null}
      <RowMenu
        id={item.id}
        customer={item.customer}
        address={item.address}
        openHref={item.openHref}
        pdfHref={item.pdfHref}
        openQuoteVersion={item.openQuoteVersion}
        canMarkLost={item.canMarkLost}
      />
    </div>
  );
}

function EstimateCard({ item: it, showEstimator, now }: { item: Item; showEstimator: boolean; now: number }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={it.openHref} prefetch={false} className={`${ROW_LINK} text-[18px]`}>
            {it.customer}
          </Link>
          {it.address ? <p className="mt-0.5 text-[15px] font-medium text-ink-2">{it.address}</p> : null}
        </div>
        <Badge status={it.status} />
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <span className="sr-only">Price: </span>
          {it.price === null ? (
            <span className="text-[15px] font-semibold text-ink-3">No price yet</span>
          ) : (
            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="gauge-m text-[26px] text-ink">{formatMoney(it.price)}</span>
              {it.priceLabel ? <span className="sign-label text-ink-2 [--sign-size:11px]">{it.priceLabel}</span> : null}
            </span>
          )}
        </div>
        <RowActions item={it} />
      </div>
      <div className="text-[15px] leading-snug font-medium">
        {it.activity ? <p className="text-ink-2">{it.activity}</p> : null}
        <p className="text-ink-3">
          {showEstimator ? `${it.estimator} · updated ` : 'Updated '}
          <Updated at={it.updatedAt} now={now} />
        </p>
      </div>
    </div>
  );
}

/** Many estimators: a drop-down and a Show button (works without a script, like the old filter). */
function EstimatorPicker({ estimators, current, status }: { estimators: Array<{ id: string; full_name: string }>; current: string | null; status: string | null }) {
  return (
    <form method="get" action="/estimates" className="flex flex-wrap items-end gap-2" aria-label="Filter by estimator">
      {status ? <input type="hidden" name="status" value={status} /> : null}
      <Field label="Estimator" className="min-w-56">
        <Select name="estimator" defaultValue={current ?? ''}>
          <option value="">Everyone</option>
          {estimators.map((e) => (
            <option key={e.id} value={e.id}>
              {e.full_name}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" size="sm">
        Show
      </Button>
    </form>
  );
}
