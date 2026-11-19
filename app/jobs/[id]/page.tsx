import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { Alert, Badge, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { formatDateTime, formatMoney, formatPhone, num, pct } from '@/lib/format';
import { Ban, Banner, ButtonLink, CircleDashed, Download, Icon, jobBadgeStatus, Mail, PencilLine, Phone, ShieldCheck, StatusBadge, Tag } from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { FactStrip } from '@/components/office';
import { UNIT_LABELS } from '@/lib/jobs/crew';
import { formatNyDateTime, formatYmd, nyDate } from '@/lib/jobs/dates';
import { compareActuals, costTotals, signedOption, type CompareRow, type OfficeActual } from '@/lib/jobs/office';
import { allowedTransitions, JOB_STATUS_LABELS, VERIFIED_STATUS_TEXT, type JobStatus } from '@/lib/jobs/status';
import { formatVariance, varianceTone } from '@/lib/jobs/variance';
import type { ProductCode, ProductUnit } from '@/lib/pricing';
import { ActionForm, ToggleInput } from '../../admin/pricing/ActionForm';
import { NumberField, TextField } from '../../admin/pricing/fields';
import { changeStatus, saveActual, saveSchedule, setExcluded, unverifyActuals, verifyActuals } from '../actions';
import { loadCrews, loadJob } from '../data';

export const metadata: Metadata = { title: 'Job' };

/** Costs and revenue with cents, as the actuals were entered. */
const usdCents = { format: (n: number) => formatMoney(n, { cents: 'always' }) };

const ACTION_LABEL: Record<JobStatus, string> = {
  scheduled: 'Back to scheduled',
  in_progress: 'Mark in progress',
  completed: 'Mark completed',
  cancelled: 'Cancel job',
};

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const profile = await requireRole('owner', 'office');
  const { id } = await params;
  if (!z.guid().safeParse(id).success) notFound();
  const db = await createClient();
  const [{ job, error }, crews] = await Promise.all([loadJob(db, id), loadCrews(db)]);
  if (!job && !error) notFound();

  if (!job) {
    return (
      <main className="@container mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        <PageHeader back={{ href: '/jobs', label: 'Jobs' }} title="This job did not load" />
        <Banner
          tone="bad"
          title="Could not load this job"
          action={
            <ButtonLink href={`/jobs/${id}`} size="sm" prefetch={false}>
              Try again
            </ButtonLink>
          }
        >
          {error}
        </Banner>
      </main>
    );
  }

  const today = nyDate(new Date());
  const option = signedOption(job.quote?.snapshot, job.quote?.signedTier ?? null, job.quote?.signedPrice ?? job.revenue);
  const { rows, job: jobCmp } = compareActuals({
    snapshot: job.quote?.snapshot,
    signedTier: job.quote?.signedTier ?? null,
    areas: job.areas,
    actuals: job.actuals,
    driveMinutesEstFallback: job.driveMinutesEst,
  });
  const costs = costTotals(job.actuals);
  const verifiedCount = job.actuals.filter((a) => a.verifiedAt).length;
  const transitions = allowedTransitions(job.status, profile.role, verifiedCount);
  const badge = jobBadgeStatus({ status: job.status, scheduledStart: job.scheduledStart, actualsCount: job.actuals.length, verifiedCount });
  const revenue = option?.price ?? job.revenue;
  const crewOptions = crews.filter((c) => c.active || c.id === job.crewId);
  const phoneHref = job.customer.phone ? `tel:${job.customer.phone.replace(/[^\d+]/g, '')}` : null;

  return (
    <>
      <main className="@container mx-auto max-w-6xl space-y-5 px-4 py-6 md:px-6">
        <PageHeader back={{ href: '/jobs', label: 'Jobs' }} title={job.customer.name} meta={<StatusBadge status={badge} />} description={job.address} />
        <div className="-mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-[16px] font-semibold text-ink-2">
          {phoneHref ? (
            <a href={phoneHref} className="-ml-1 inline-flex min-h-12 items-center gap-2 rounded-control px-1 font-bold text-ink underline underline-offset-4 hover:bg-sunken">
              <Icon icon={Phone} size="s" />
              {formatPhone(job.customer.phone)}
            </a>
          ) : (
            <span className="inline-flex min-h-12 items-center gap-2">
              <Icon icon={Phone} size="s" />
              No phone
            </span>
          )}
          {job.customer.email ? (
            <a href={`mailto:${job.customer.email}`} className="inline-flex min-h-12 items-center gap-2 rounded-control px-1 font-bold text-ink underline underline-offset-4 hover:bg-sunken [overflow-wrap:anywhere]">
              <Icon icon={Mail} size="s" />
              {job.customer.email}
            </a>
          ) : null}
        </div>

        <FactStrip
          title="About this job"
          facts={[
            {
              key: 'option',
              label: 'Signed option',
              value: option ? (
                <span className="flex flex-col gap-1">
                  <span>{option.label}</span>
                  {option.price != null ? <span className="gauge-m text-[22px]">{formatMoney(option.price)}</span> : null}
                </span>
              ) : (
                '—'
              ),
            },
            {
              key: 'quote',
              label: 'Quote',
              value: job.quote ? (
                <span className="flex flex-col gap-1">
                  <span>
                    Quote v{job.quote.version}
                    {job.quote.signedAt ? `, signed ${formatDateTime(job.quote.signedAt)}` : ''}
                  </span>
                  <a className="-my-2 inline-flex min-h-12 items-center gap-1.5 self-start rounded-control font-bold text-ink underline underline-offset-4 hover:bg-sunken" href={`/api/quotes/${job.quote.id}/pdf`} target="_blank" rel="noopener">
                    <Icon icon={Download} size="s" />
                    PDF
                  </a>
                </span>
              ) : (
                '—'
              ),
            },
            { key: 'estimator', label: 'Estimator', value: job.estimator ?? '—' },
            {
              key: 'work',
              label: 'Work',
              value: (
                <>
                  {job.startedAt ? `Started ${formatDateTime(job.startedAt)}` : 'Not started'}
                  {job.completedAt ? <span className="block">Done {formatDateTime(job.completedAt)}</span> : null}
                </>
              ),
            },
          ]}
        />

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Crew and schedule</h2>
            <p className="mb-3 text-sm text-slate-600">
              {job.scheduledStart ? `Starts ${formatYmd(job.scheduledStart, today)}` : 'Not scheduled yet'}
              {job.scheduledDays ? ` · ${num(job.scheduledDays, 1)} day${job.scheduledDays === 1 ? '' : 's'}` : ''}
            </p>
            <ActionForm action={saveSchedule} readOnly={false} submitLabel="Save schedule">
              <input type="hidden" name="id" value={job.id} />
              {/* Crew on its own row; the date keeps room for a whole date (11/18/2026) at every width. */}
              <div className="grid gap-3">
                <Field label="Crew">
                  <Select name="crew_id" defaultValue={job.crewId ?? ''}>
                    <option value="">Unassigned</option>
                    {crewOptions.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.active ? '' : ' (inactive)'}
                      </option>
                    ))}
                  </Select>
                </Field>
                <div className="grid grid-cols-[minmax(11.5rem,1fr)_minmax(5rem,7rem)] gap-3">
                  <Field label="Start date">
                    <Input type="date" name="scheduled_start" defaultValue={job.scheduledStart ?? ''} />
                  </Field>
                  <NumberField label="Days" name="scheduled_days" defaultValue={job.scheduledDays} required={false} />
                </div>
              </div>
            </ActionForm>
          </Card>

          <Card>
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Status</h2>
            <p className="mb-3 text-sm text-slate-600">Crews start and complete jobs from the crew app. Change it here when they cannot.</p>
            {transitions.length === 0 ? (
              <p className="text-sm text-slate-500">
                {verifiedCount > 0
                  ? VERIFIED_STATUS_TEXT[profile.role === 'owner' ? 'owner' : 'office']
                  : `No status changes are possible from ${JOB_STATUS_LABELS[job.status].toLowerCase()}.`}
              </p>
            ) : null}
            <div className="space-y-3">
              {transitions.map((t) => (
                <ActionForm key={t} action={changeStatus} readOnly={false} submitLabel={ACTION_LABEL[t]} submitVariant={t === 'cancelled' ? 'danger' : 'secondary'}>
                  <input type="hidden" name="id" value={job.id} />
                  <input type="hidden" name="status" value={t} />
                  {t === 'cancelled' ? (
                    <label className="flex min-h-12 items-center gap-3 text-sm text-slate-700">
                      <input type="checkbox" name="confirm" value="true" className="h-5 w-5" />
                      Yes, cancel this job (the crew stops seeing it)
                    </label>
                  ) : null}
                </ActionForm>
              ))}
            </div>
          </Card>
        </div>

        <Card className="overflow-x-auto p-0">
          <div className="p-4 pb-2">
            <h2 className="text-lg font-semibold text-slate-900">Actuals vs estimate</h2>
            <p className="text-sm text-slate-600">
              Estimate = the signed option&apos;s quantities and hours. Variance: <Badge tone="green">within 10%</Badge> <Badge tone="amber">within 25%</Badge>{' '}
              <Badge tone="red">beyond</Badge>
            </p>
          </div>
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th scope="col" className="px-4 py-2">Area · product</th>
                <th scope="col" className="px-3 py-2 text-right">Est. qty</th>
                <th scope="col" className="px-3 py-2 text-right">Actual</th>
                <th scope="col" className="px-3 py-2">Var.</th>
                <th scope="col" className="px-3 py-2 text-right">Est. hrs</th>
                <th scope="col" className="px-3 py-2 text-right">Actual</th>
                <th scope="col" className="px-3 py-2">Var.</th>
                <th scope="col" className="px-4 py-2">Row</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-3 text-slate-500">
                    The signed quote has no area scope to compare.
                  </td>
                </tr>
              ) : null}
              {rows.map((r) => (
                <tr key={r.key} className="align-middle">
                  <td className="px-4 py-2">
                    <span className="font-medium text-slate-900">{r.areaName}</span> · {r.label}
                    {r.inScope ? null : <span className="ml-1 text-xs text-slate-500">(not in quote)</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.hasMaterial ? qty(r.estQty, r.unit) : ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.hasMaterial ? qty(r.actualQty, r.unit) : ''}</td>
                  <td className="px-3 py-2">{r.hasMaterial ? <VarianceBadge pct={r.qtyVariance} /> : null}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.estHours !== null ? num(r.estHours, 1) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.actualHours !== null ? num(r.actualHours, 1) : '—'}</td>
                  <td className="px-3 py-2">
                    <VarianceBadge pct={r.hoursVariance} />
                  </td>
                  <td className="px-4 py-2">
                    <RowBadge actual={r.actual} />
                  </td>
                </tr>
              ))}
              <tr className="bg-slate-50/60 align-middle">
                <td className="px-4 py-2 font-medium text-slate-900">Whole job: drive min (one way) · days</td>
                <td className="px-3 py-2 text-right tabular-nums">{jobCmp.estDriveMinutes !== null ? num(jobCmp.estDriveMinutes) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{jobCmp.actualDriveMinutes !== null ? num(jobCmp.actualDriveMinutes) : '—'}</td>
                <td className="px-3 py-2">
                  <VarianceBadge pct={jobCmp.driveVariance} />
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{jobCmp.estDays !== null ? `${num(jobCmp.estDays, 1)} d` : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums">{jobCmp.actualDays !== null ? `${num(jobCmp.actualDays, 1)} d` : '—'}</td>
                <td className="px-3 py-2">
                  <VarianceBadge pct={jobCmp.daysVariance} />
                </td>
                <td className="px-4 py-2">
                  <RowBadge actual={jobCmp.actual} />
                  {jobCmp.actualCrewSize !== null ? <span className="ml-1 text-xs text-slate-500">crew of {jobCmp.actualCrewSize}</span> : null}
                </td>
              </tr>
            </tbody>
          </table>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">Verification</h2>
            {job.actuals.length === 0 ? (
              <p className="text-sm text-slate-600">No actuals yet. The crew enters them in the crew app, or enter them below.</p>
            ) : (
              <p className="text-sm text-slate-600">
                {verifiedCount} of {job.actuals.length} row{job.actuals.length === 1 ? '' : 's'} verified
                {verifiedCount ? ` (last by ${lastVerifier(job.actuals)})` : ''}. Verified rows are locked for the crew and feed learning unless excluded.
              </p>
            )}
            <div className="mt-3 space-y-3">
              {job.status === 'completed' && job.actuals.length > verifiedCount ? (
                <ActionForm action={verifyActuals} readOnly={false} submitLabel="Verify actuals">
                  <input type="hidden" name="id" value={job.id} />
                  <p className="text-sm text-slate-700">Check the numbers above against the crew&apos;s sheet and invoices first.</p>
                </ActionForm>
              ) : job.status !== 'completed' && job.actuals.length ? (
                <Alert tone="blue">Actuals can be verified once the job is completed.</Alert>
              ) : null}
              {profile.role === 'owner' && verifiedCount > 0 ? (
                <ActionForm action={unverifyActuals} readOnly={false} submitLabel="Unverify" submitVariant="danger">
                  <input type="hidden" name="id" value={job.id} />
                  <p className="text-sm text-slate-700">Owner only: unlocks the rows so they can be corrected. They leave learning until verified again.</p>
                </ActionForm>
              ) : null}
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 text-lg font-semibold text-slate-900">Costs</h2>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <Item label="Material">{costs.material !== null ? usdCents.format(costs.material) : '—'}</Item>
              <Item label="Labor">{costs.labor !== null ? usdCents.format(costs.labor) : '—'}</Item>
              <Item label="Other">{costs.other !== null ? usdCents.format(costs.other) : '—'}</Item>
              <Item label="Total">{costs.total !== null ? usdCents.format(costs.total) : '—'}</Item>
              <Item label="Revenue">{revenue != null ? usdCents.format(revenue) : '—'}</Item>
              <Item label="Gross margin">
                {costs.total !== null && revenue != null && revenue > 0 ? `${usdCents.format(revenue - costs.total)} (${pct((revenue - costs.total) / revenue, 1)})` : '—'}
              </Item>
            </dl>
            <p className="mt-2 text-xs text-slate-500">From invoices and payroll, entered per row below. Office and owner only.</p>
          </Card>
        </div>

        <section className="space-y-3" aria-labelledby="enter-actuals">
          <h2 id="enter-actuals" className="text-lg font-semibold text-slate-900">
            Enter or correct actuals
          </h2>
          {rows.map((r) => (
            <RowEditor key={r.key} jobId={job.id} row={r} />
          ))}
          <JobRowEditor jobId={job.id} actual={jobCmp.actual} />
        </section>
      </main>
    </>
  );
}

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-slate-900">{children}</dd>
    </div>
  );
}

const qty = (n: number | null, unit: ProductUnit | null) => (n === null ? '—' : `${num(n, 1)}${unit ? ` ${UNIT_LABELS[unit]}` : ''}`);

function VarianceBadge({ pct }: { pct: number | null }) {
  const tone = varianceTone(pct);
  return tone ? <Badge tone={tone}>{formatVariance(pct)}</Badge> : <span className="text-slate-400">—</span>;
}

/** One actuals row's state: icon + word + colour, Verified as on the job's own badge. */
function RowBadge({ actual }: { actual: OfficeActual | null }) {
  if (!actual)
    return (
      <Tag tone="warn" icon={CircleDashed}>
        Not entered
      </Tag>
    );
  if (actual.excluded)
    return (
      <Tag tone="draft" icon={Ban}>
        Excluded
      </Tag>
    );
  if (actual.verifiedAt)
    return (
      <Tag tone="ok" icon={ShieldCheck}>
        Verified
      </Tag>
    );
  return (
    <Tag tone="info" icon={PencilLine}>
      Entered
    </Tag>
  );
}

function lastVerifier(actuals: OfficeActual[]): string {
  const last = actuals.filter((a) => a.verifiedAt).sort((a, b) => (b.verifiedAt ?? '').localeCompare(a.verifiedAt ?? ''))[0];
  return last ? `${last.verifiedBy ?? 'someone'}, ${formatNyDateTime(last.verifiedAt!)}` : '';
}

function Entered({ actual }: { actual: OfficeActual | null }) {
  if (!actual) return <span className="text-xs text-slate-500">Not entered yet</span>;
  return (
    <span className="text-xs text-slate-500">
      Entered by {actual.enteredBy ?? 'unknown'}
      {actual.enteredAt ? `, ${formatNyDateTime(actual.enteredAt)}` : ''}
      {actual.verifiedAt ? ` · verified by ${actual.verifiedBy ?? 'unknown'}` : ''}
    </span>
  );
}

/** A verified row's numbers are shown, not edited (and not sent: its save writes costs only). */
function Locked({ value, label }: { value: string | number | null; label: string }) {
  return (
    <div>
      <p className="text-sm text-slate-500">{label}</p>
      <p className="min-h-12 whitespace-pre-line py-3 font-medium text-slate-900">{value === null || value === '' ? '—' : value}</p>
    </div>
  );
}

/** Notes keep the crew's line breaks. */
function NotesField({ defaultValue }: { defaultValue: string | null | undefined }) {
  return (
    <Field label="Notes" className="col-span-full">
      <Textarea name="notes" rows={3} maxLength={2000} defaultValue={defaultValue ?? ''} />
    </Field>
  );
}

function CostFields({ actual }: { actual: OfficeActual | null }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <NumberField label="Material cost" name="material_cost" prefix="$" defaultValue={actual?.materialCost} required={false} />
      <NumberField label="Labor cost" name="labor_cost" prefix="$" defaultValue={actual?.laborCost} required={false} />
      <NumberField label="Other cost" name="other_cost" prefix="$" defaultValue={actual?.otherCost} required={false} />
    </div>
  );
}

function RowEditor({ jobId, row }: { jobId: string; row: CompareRow }) {
  const a = row.actual;
  const locked = Boolean(a?.verifiedAt);
  const unit = row.unit ? UNIT_LABELS[row.unit] : 'units';
  return (
    <Card>
      <details>
        <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-slate-900">
            {row.areaName} · {row.label}
          </span>
          <span className="flex items-center gap-2">
            <RowBadge actual={a} />
            <span className="text-sm font-semibold text-brand-800">Edit</span>
          </span>
        </summary>
        <div className="mt-3 space-y-4">
          <Entered actual={a} />
          <ActionForm action={saveActual} readOnly={false} submitLabel={a ? 'Save row' : 'Add actuals'}>
            <Hidden jobId={jobId} id={a?.id ?? null} areaId={row.areaId} product={row.product} unit={row.unit} />
            {locked ? (
              <div className="grid gap-3 sm:grid-cols-3">
                {row.hasMaterial ? <Locked value={a?.materialQty ?? null} label={`${unit} used`} /> : null}
                <Locked value={a?.hours ?? null} label="Person-hours" />
                <Locked value={a?.notes ?? null} label="Notes" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                {row.hasMaterial ? (
                  <NumberField
                    label={`${unit[0]!.toUpperCase()}${unit.slice(1)} used`}
                    name="material_qty"
                    defaultValue={a?.materialQty}
                    placeholder={row.estQty !== null ? String(row.estQty) : undefined}
                    required={false}
                  />
                ) : null}
                <NumberField label="Person-hours" name="hours" defaultValue={a?.hours} placeholder={row.estHours !== null ? String(row.estHours) : undefined} required={false} />
                <NotesField defaultValue={a?.notes} />
              </div>
            )}
            <CostFields actual={a} />
          </ActionForm>
          {a ? <ExcludeForm jobId={jobId} actual={a} /> : null}
        </div>
      </details>
    </Card>
  );
}

function JobRowEditor({ jobId, actual }: { jobId: string; actual: OfficeActual | null }) {
  const locked = Boolean(actual?.verifiedAt);
  return (
    <Card>
      <details>
        <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-2">
          <span className="font-semibold text-slate-900">Whole job: drive, days, crew size, other costs</span>
          <span className="flex items-center gap-2">
            <RowBadge actual={actual} />
            <span className="text-sm font-semibold text-brand-800">Edit</span>
          </span>
        </summary>
        <div className="mt-3 space-y-4">
          <Entered actual={actual} />
          <ActionForm action={saveActual} readOnly={false} submitLabel={actual ? 'Save row' : 'Add actuals'}>
            <Hidden jobId={jobId} id={actual?.id ?? null} areaId={null} product={null} unit={null} />
            {locked ? (
              <div className="grid gap-3 sm:grid-cols-4">
                <Locked value={actual?.driveMinutes ?? null} label="Drive, one way (min)" />
                <Locked value={actual?.days ?? null} label="Days on site" />
                <Locked value={actual?.crewSize ?? null} label="Crew size" />
                <Locked value={actual?.notes ?? null} label="Notes" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-4">
                <NumberField label="Drive, one way (min)" name="drive_minutes" defaultValue={actual?.driveMinutes} required={false} />
                <NumberField label="Days on site" name="days" defaultValue={actual?.days} required={false} />
                <NumberField label="Crew size" name="crew_size" integer defaultValue={actual?.crewSize} required={false} />
                <NotesField defaultValue={actual?.notes} />
              </div>
            )}
            <CostFields actual={actual} />
          </ActionForm>
          {actual ? <ExcludeForm jobId={jobId} actual={actual} /> : null}
        </div>
      </details>
    </Card>
  );
}

function Hidden({ jobId, id, areaId, product, unit }: { jobId: string; id: string | null; areaId: string | null; product: ProductCode | null; unit: ProductUnit | null }) {
  return (
    <>
      <input type="hidden" name="job_id" value={jobId} />
      <input type="hidden" name="id" value={id ?? ''} />
      <input type="hidden" name="area_id" value={areaId ?? ''} />
      <input type="hidden" name="product" value={product ?? ''} />
      <input type="hidden" name="material_unit" value={unit ?? ''} />
    </>
  );
}

function ExcludeForm({ jobId, actual }: { jobId: string; actual: OfficeActual }) {
  return (
    <ActionForm action={setExcluded} readOnly={false} submitLabel="Save learning setting">
      <input type="hidden" name="job_id" value={jobId} />
      <input type="hidden" name="id" value={actual.id} />
      <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
        <ToggleInput name="exclude" label="Exclude from learning" hint="For callbacks, rework or anything unusual" defaultChecked={actual.excluded} />
        <TextField label="Reason (required to exclude)" name="reason" defaultValue={actual.excludeReason} placeholder="e.g. callback to fix a missed bay" />
      </div>
    </ActionForm>
  );
}
