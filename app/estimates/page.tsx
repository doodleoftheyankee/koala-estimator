import type { Metadata } from 'next';
import Link from 'next/link';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Button, Card, Field, Select, Textarea } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { canMarkLost } from '@/lib/jobs/forms';
import { ActionForm } from '../admin/pricing/ActionForm';
import { markLost } from './actions';

export const metadata: Metadata = { title: 'Estimates' };

const ESTIMATE_STATUSES = ['draft', 'ready', 'sent', 'viewed', 'signed', 'lost', 'expired', 'void'] as const;
type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

const STATUS_TONE: Record<EstimateStatus, 'slate' | 'green' | 'amber' | 'red' | 'blue'> = {
  draft: 'slate',
  ready: 'blue',
  sent: 'blue',
  viewed: 'amber',
  signed: 'green',
  lost: 'red',
  expired: 'slate',
  void: 'slate',
};

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

function totalOf(r: Row, quote: NonNullable<Row['quotes']>[number] | undefined): number | null {
  if (quote?.signed_price != null) return quote.signed_price;
  const selected = r.options?.find((o) => o.tier === r.selected_tier);
  if (selected?.price != null) return selected.price;
  return r.model_total_price ?? null;
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 2 });
const when = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

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
    .limit(200);
  if (status) query = query.eq('status', status);
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

  const items = rows.map((r) => {
    const quote = r.quotes?.[0];
    return {
      id: r.id,
      status: r.status,
      customer: r.customer ? `${r.customer.first_name} ${r.customer.last_name}`.trim() : '—',
      address: r.property ? `${r.property.street}, ${r.property.city}` : '—',
      estimator: r.estimator?.full_name ?? '—',
      total: totalOf(r, quote),
      updated: when.format(new Date(r.updated_at)),
      quote,
      lostReason: r.status === 'lost' ? (r.lost_reason ?? null) : null,
    };
  });
  const filtered = Boolean(status || estimatorId);

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-slate-900">Estimates</h1>
          {canFilterEstimator ? (
            <Link href="/jobs" className="ml-auto inline-flex min-h-12 items-center rounded-xl px-3 font-semibold text-brand-800 hover:bg-brand-50">
              Jobs
            </Link>
          ) : null}
          <Link
            href="/field?new=1"
            className="inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-5 text-base font-semibold text-white shadow-sm hover:bg-brand-800 focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100"
          >
            + New estimate
          </Link>
        </div>

        <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Filter estimates">
          <Field label="Status" className="w-full sm:w-48">
            <Select name="status" defaultValue={status ?? ''}>
              <option value="">All statuses</option>
              {ESTIMATE_STATUSES.map((s) => (
                <option key={s} value={s} className="capitalize">
                  {s[0]!.toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          {canFilterEstimator ? (
            <Field label="Estimator" className="w-full sm:w-56">
              <Select name="estimator" defaultValue={estimatorId ?? ''}>
                <option value="">Everyone</option>
                {estimators.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.full_name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Button type="submit" variant="secondary">
            Apply
          </Button>
          {filtered ? (
            <Link href="/estimates" className="inline-flex min-h-12 items-center rounded-xl px-3 font-semibold text-brand-800 hover:bg-brand-50">
              Clear
            </Link>
          ) : null}
        </form>

        {error ? <Alert tone="red">Could not load estimates: {error}</Alert> : null}
        {!error && items.length === 0 ? (
          <Card>
            <p className="text-slate-600">{filtered ? 'No estimates match these filters.' : 'No estimates yet. Start one with “New estimate”.'}</p>
          </Card>
        ) : null}

        {items.length ? (
          <>
            {/* Phones: cards */}
            <ul className="space-y-3 md:hidden">
              {items.map((it) => (
                <li key={it.id}>
                  <Card>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-slate-900">{it.customer}</p>
                        <p className="truncate text-sm text-slate-600">{it.address}</p>
                      </div>
                      <StatusBadge status={it.status} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-baseline justify-between gap-2 text-sm text-slate-600">
                      <span className="text-lg font-bold tabular-nums text-slate-900">{it.total != null ? usd.format(it.total) : '—'}</span>
                      <span>
                        {it.estimator} · {it.updated}
                      </span>
                    </div>
                    {it.quote ? <QuoteLine quote={it.quote} /> : null}
                    {it.lostReason ? <LostReason reason={it.lostReason} /> : null}
                    <div className="mt-3 flex gap-2">
                      <RowActions id={it.id} quoteId={it.quote?.id ?? null} />
                    </div>
                    {canMarkLost(it.status) ? <MarkLost id={it.id} /> : null}
                  </Card>
                </li>
              ))}
            </ul>

            {/* md+: table */}
            <Card className="hidden overflow-x-auto p-0 md:block">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th scope="col" className="px-4 py-3">Customer</th>
                    <th scope="col" className="px-4 py-3">Address</th>
                    <th scope="col" className="px-4 py-3">Estimator</th>
                    <th scope="col" className="px-4 py-3">Status</th>
                    <th scope="col" className="px-4 py-3 text-right">Total</th>
                    <th scope="col" className="px-4 py-3">Updated</th>
                    <th scope="col" className="px-4 py-3">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it) => (
                    <tr key={it.id} className="align-middle hover:bg-slate-50">
                      <td className="px-4 py-3 font-medium text-slate-900">{it.customer}</td>
                      <td className="px-4 py-3 text-slate-600">{it.address}</td>
                      <td className="px-4 py-3 text-slate-600">{it.estimator}</td>
                      <td className="px-4 py-3">
                        <StatusBadge status={it.status} />
                        {it.quote ? <QuoteLine quote={it.quote} compact /> : null}
                        {it.lostReason ? <LostReason reason={it.lostReason} /> : null}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums text-slate-900">{it.total != null ? usd.format(it.total) : '—'}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{it.updated}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <RowActions id={it.id} quoteId={it.quote?.id ?? null} />
                        </div>
                        {canMarkLost(it.status) ? <MarkLost id={it.id} popover /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {items.length === 200 ? <p className="text-sm text-slate-500">Showing the 200 most recent. Use the filters to narrow down.</p> : null}
          </>
        ) : null}
      </main>
    </>
  );
}

function StatusBadge({ status }: { status: EstimateStatus }) {
  return (
    <Badge tone={STATUS_TONE[status]}>
      <span className="capitalize">{status}</span>
    </Badge>
  );
}

function QuoteLine({ quote, compact = false }: { quote: NonNullable<Row['quotes']>[number]; compact?: boolean }) {
  const date = quote.signed_at ?? quote.sent_at;
  const label = quote.signed_at ? 'signed' : quote.status;
  return (
    <p className={compact ? 'mt-1 text-xs text-slate-500' : 'mt-2 text-xs text-slate-500'}>
      Quote v{quote.version} {label}
      {date ? ` ${when.format(new Date(date))}` : ''}
    </p>
  );
}

const actionLink =
  'inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold focus:outline-none focus-visible:ring-4 focus-visible:ring-brand-100';

function RowActions({ id, quoteId }: { id: string; quoteId: string | null }) {
  return (
    <>
      <Link href={`/field?e=${encodeURIComponent(id)}`} className={`${actionLink} flex-1 bg-brand-700 text-white hover:bg-brand-800 md:flex-none`}>
        Open
      </Link>
      {quoteId ? (
        <a
          href={`/api/quotes/${encodeURIComponent(quoteId)}/pdf`}
          target="_blank"
          rel="noopener"
          className={`${actionLink} flex-1 bg-white text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50 md:flex-none`}
        >
          PDF
        </a>
      ) : null}
    </>
  );
}

function LostReason({ reason }: { reason: string }) {
  return <p className="mt-1 max-w-xs text-xs text-red-700">Lost: {reason}</p>;
}

/** Record that the customer went elsewhere (or went quiet), with the reason. No JavaScript needed to open it. */
function MarkLost({ id, popover = false }: { id: string; popover?: boolean }) {
  return (
    <details className={popover ? 'relative mt-1 text-right' : 'mt-2'}>
      <summary className="inline-flex min-h-11 cursor-pointer list-none items-center rounded-xl px-3 text-sm font-semibold text-red-700 hover:bg-red-50">Mark lost…</summary>
      <div className={popover ? 'absolute right-0 top-full z-10 mt-1 w-80 rounded-2xl bg-white p-3 text-left shadow-lg ring-1 ring-slate-200' : 'mt-2'}>
        <ActionForm action={markLost} readOnly={false} submitLabel="Mark lost">
          <input type="hidden" name="id" value={id} />
          <Field label="Why was it lost?" hint="Price, timing, went with a competitor, no response…">
            <Textarea name="reason" rows={2} required maxLength={500} />
          </Field>
        </ActionForm>
      </div>
    </details>
  );
}
