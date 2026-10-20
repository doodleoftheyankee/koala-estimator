import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { z } from 'zod';
import { AppNav } from '@/components/AppNav';
import { Alert, Badge, Card, Field, Input, Select } from '@/components/ui';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { num } from '@/lib/format';
import { UNIT_LABELS } from '@/lib/jobs/crew';
import { formatNyDateTime, formatYmd, nyDate } from '@/lib/jobs/dates';
import { compareActuals, costTotals, signedOption, type CompareRow, type OfficeActual } from '@/lib/jobs/office';
import { allowedTransitions, JOB_STATUS_LABELS, officeGroup, OFFICE_GROUP_LABELS, type JobStatus } from '@/lib/jobs/status';
import { formatVariance, varianceTone } from '@/lib/jobs/variance';
import type { ProductCode, ProductUnit } from '@/lib/pricing';
import { ActionForm, ToggleInput } from '../../admin/pricing/ActionForm';
import { NumberField, TextField } from '../../admin/pricing/fields';
import { changeStatus, saveActual, saveSchedule, setExcluded, unverifyActuals, verifyActuals } from '../actions';
import { loadCrews, loadJob } from '../data';

export const metadata: Metadata = { title: 'Job' };

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const usdCents = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

const STATUS_TONE: Record<JobStatus, 'slate' | 'green' | 'amber' | 'blue'> = { scheduled: 'blue', in_progress: 'amber', completed: 'green', cancelled: 'slate' };
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
      <>
        <AppNav profile={profile} />
        <main className="mx-auto max-w-6xl space-y-4 px-4 py-6">
          <BackLink />
          <Alert tone="red">Could not load this job: {error}</Alert>
        </main>
      </>
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
  const transitions = allowedTransitions(job.status, profile.role);
  const verifiedCount = job.actuals.filter((a) => a.verifiedAt).length;
  const group = officeGroup({ status: job.status, actualsCount: job.actuals.length, verifiedCount });
  const revenue = option?.price ?? job.revenue;
  const crewOptions = crews.filter((c) => c.active || c.id === job.crewId);

  return (
    <>
      <AppNav profile={profile} />
      <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
        <BackLink />
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-slate-900">{job.customer.name}</h1>
            <p className="text-slate-600">{job.address}</p>
            <p className="text-sm text-slate-600">
              {job.customer.phone ? (
                <a className="font-medium text-brand-800 underline" href={`tel:${job.customer.phone.replace(/[^\d+]/g, '')}`}>
                  {job.customer.phone}
                </a>
              ) : (
                'No phone'
              )}
              {job.customer.email ? ` · ${job.customer.email}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge tone={STATUS_TONE[job.status]}>{JOB_STATUS_LABELS[job.status]}</Badge>
            {job.status === 'completed' ? <Badge tone={group === 'verified' ? 'green' : 'amber'}>{OFFICE_GROUP_LABELS[group]}</Badge> : null}
          </div>
        </div>

        <Card>
          <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Item label="Signed option">
              {option ? `${option.label}${option.price != null ? ` · ${usd.format(option.price)}` : ''}` : '—'}
            </Item>
            <Item label="Quote">
              {job.quote ? `v${job.quote.version}${job.quote.signedAt ? `, signed ${formatNyDateTime(job.quote.signedAt)}` : ''}` : '—'}
              {job.quote ? (
                <>
                  {' · '}
                  <a className="font-medium text-brand-800 underline" href={`/api/quotes/${job.quote.id}/pdf`} target="_blank" rel="noopener">
                    PDF
                  </a>
                </>
              ) : null}
            </Item>
            <Item label="Estimator">{job.estimator ?? '—'}</Item>
            <Item label="Work">
              {job.startedAt ? `Started ${formatNyDateTime(job.startedAt)}` : 'Not started'}
              {job.completedAt ? ` · completed ${formatNyDateTime(job.completedAt)}` : ''}
            </Item>
          </dl>
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Crew and schedule</h2>
            <p className="mb-3 text-sm text-slate-600">
              {job.scheduledStart ? `Starts ${formatYmd(job.scheduledStart, today)}` : 'Not scheduled yet'}
              {job.scheduledDays ? ` · ${num(job.scheduledDays, 1)} day${job.scheduledDays === 1 ? '' : 's'}` : ''}
            </p>
            <ActionForm action={saveSchedule} readOnly={false} submitLabel="Save schedule">
              <input type="hidden" name="id" value={job.id} />
              <div className="grid gap-3 sm:grid-cols-3">
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
                <Field label="Start date">
                  <Input type="date" name="scheduled_start" defaultValue={job.scheduledStart ?? ''} />
                </Field>
                <NumberField label="Days" name="scheduled_days" defaultValue={job.scheduledDays} required={false} />
              </div>
            </ActionForm>
          </Card>

          <Card>
            <h2 className="mb-1 text-lg font-semibold text-slate-900">Status</h2>
            <p className="mb-3 text-sm text-slate-600">Crews start and complete jobs from the crew app. Change it here when they cannot.</p>
            {transitions.length === 0 ? <p className="text-sm text-slate-500">No status changes are possible from {JOB_STATUS_LABELS[job.status].toLowerCase()}.</p> : null}
            <div className="space-y-3">
              {transitions.map((t) => (
                <ActionForm key={t} action={changeStatus} readOnly={false} submitLabel={ACTION_LABEL[t]}>
                  <input type="hidden" name="id" value={job.id} />
                  <input type="hidden" name="status" value={t} />
                  {t === 'cancelled' ? (
                    <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
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
                <ActionForm action={unverifyActuals} readOnly={false} submitLabel="Unverify">
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
                {costs.total !== null && revenue != null && revenue > 0 ? `${usdCents.format(revenue - costs.total)} (${(((revenue - costs.total) / revenue) * 100).toFixed(1)}%)` : '—'}
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

function BackLink() {
  return (
    <Link href="/jobs" className="inline-flex min-h-11 items-center rounded-xl px-2 font-semibold text-brand-800 hover:bg-brand-50">
      ‹ All jobs
    </Link>
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

function RowBadge({ actual }: { actual: OfficeActual | null }) {
  if (!actual) return <Badge tone="amber">Not entered</Badge>;
  if (actual.excluded) return <Badge tone="slate">Excluded</Badge>;
  if (actual.verifiedAt) return <Badge tone="green">Verified</Badge>;
  return <Badge tone="blue">Entered</Badge>;
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

/** Hidden copies of the stored values: a verified row's numbers are shown, not edited. */
function Locked({ name, value, label }: { name: string; value: string | number | null; label: string }) {
  return (
    <div>
      <input type="hidden" name={name} value={value === null ? '' : String(value)} />
      <p className="text-sm text-slate-500">{label}</p>
      <p className="min-h-12 py-3 font-medium text-slate-900">{value === null || value === '' ? '—' : value}</p>
    </div>
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
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2">
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
                {row.hasMaterial ? <Locked name="material_qty" value={a?.materialQty ?? null} label={`${unit} used`} /> : null}
                <Locked name="hours" value={a?.hours ?? null} label="Person-hours" />
                <Locked name="notes" value={a?.notes ?? null} label="Notes" />
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
                <TextField label="Notes" name="notes" defaultValue={a?.notes} />
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
        <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2">
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
                <Locked name="drive_minutes" value={actual?.driveMinutes ?? null} label="Drive, one way (min)" />
                <Locked name="days" value={actual?.days ?? null} label="Days on site" />
                <Locked name="crew_size" value={actual?.crewSize ?? null} label="Crew size" />
                <Locked name="notes" value={actual?.notes ?? null} label="Notes" />
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-4">
                <NumberField label="Drive, one way (min)" name="drive_minutes" defaultValue={actual?.driveMinutes} required={false} />
                <NumberField label="Days on site" name="days" defaultValue={actual?.days} required={false} />
                <NumberField label="Crew size" name="crew_size" integer defaultValue={actual?.crewSize} required={false} />
                <TextField label="Notes" name="notes" defaultValue={actual?.notes} />
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
