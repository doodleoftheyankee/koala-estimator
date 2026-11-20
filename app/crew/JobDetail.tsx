'use client';
import { useState } from 'react';
import { crewDb, type LocalActuals, type LocalJob } from '@/lib/offline/crewDb';
import { setJobStatus, syncActuals } from '@/lib/offline/crewSync';
import { completionBlockers } from '@/lib/offline/crewSyncCore';
import type { CachedProfile } from '@/lib/offline/db';
import { dayLabel, formatNyDateTime, nyDate } from '@/lib/jobs/dates';
import { mapsUrl, naturalKey, PRODUCT_LABELS, telUrl, UNIT_LABELS, type CrewArea, type CrewJob } from '@/lib/jobs/crew';
import type { ProductCode } from '@/lib/pricing';
import { ACCESS_LABELS, JOB_TYPE_LABELS, num } from '@/lib/format';
import { Alert, Button, Card } from '@/components/ui';
import { jobBadgeStatus, RefreshCw, Smartphone, StatusBadge, Tag } from '@/components/daymark';
import { useLive } from '@/app/field/hooks';
import { ActualsForm } from './ActualsForm';
import { ActualsTag } from './JobList';
import { useActualsEditor } from './useActualsEditor';
import { BlowerDoorLink } from '@/app/field/blower-door/BlowerDoorLink';
import { jobDays, jobLoadList, notesOf, qtyText } from '@/lib/jobs/loadList';
import { CrewNotesBlock, hasNotes } from './CrewNotes';

type Message = { tone: 'red' | 'green' | 'amber'; text: string; blockers?: string[] };


export function JobDetail({
  id,
  profile,
  online,
  onBack,
  requestSync,
  onAuthError,
}: {
  id: string;
  profile: CachedProfile;
  online: boolean;
  onBack: () => void;
  requestSync: () => void;
  onAuthError: (e: unknown) => void;
}) {
  const cached = useLive<LocalJob | undefined | 'loading'>(() => crewDb().jobs.get(id), [id], 'loading');
  const editor = useActualsEditor(id, requestSync);
  const [busy, setBusy] = useState<null | 'start' | 'undo' | 'complete'>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const back = async () => {
    await editor.flush();
    onBack();
  };

  if (cached === 'loading') return <div className="p-6 text-center text-slate-500">Loading job…</div>;
  if (!cached) {
    return (
      <div className="space-y-3 p-4">
        <Alert tone="amber">This job is no longer on this phone. It may have been reassigned or finished more than two weeks ago.</Alert>
        <Button variant="secondary" onClick={onBack}>
          ‹ Back to jobs
        </Button>
      </div>
    );
  }

  const job = cached.job;
  const draft = editor.record;
  const today = nyDate(new Date());

  async function changeStatus(kind: 'start' | 'undo') {
    setBusy(kind);
    setMessage(null);
    try {
      const r = await setJobStatus(id, kind === 'start' ? 'in_progress' : 'scheduled');
      setMessage(r.ok ? { tone: 'green', text: kind === 'start' ? 'Job started.' : 'Back to scheduled.' } : { tone: 'red', text: r.error });
    } catch (e) {
      onAuthError(e);
    } finally {
      setBusy(null);
    }
  }

  async function complete() {
    setMessage(null);
    await editor.flush();
    const stored = await crewDb().actuals.get(id);
    const blockers = stored ? completionBlockers(job, stored.rows) : ['The actuals are not on this phone yet. Sync and try again.'];
    if (blockers.length) {
      setMessage({ tone: 'amber', text: 'Fill in the actuals before completing the job:', blockers });
      return;
    }
    setBusy('complete');
    try {
      // Complete only once the server has every number the crew typed. A merge with someone
      // else's newer values goes out in a second round.
      let { record } = await syncActuals(id, profile.userId);
      if (record?.syncState === 'pending') ({ record } = await syncActuals(id, profile.userId));
      if (!record || record.syncState !== 'synced') {
        setMessage({ tone: 'red', text: `The actuals did not sync, so the job was not completed. ${record?.lastError ?? ''}`.trim() });
        return;
      }
      const r = await setJobStatus(id, 'completed');
      setMessage(r.ok ? { tone: 'green', text: 'Job completed. Thanks!' } : { tone: 'red', text: r.error, blockers: r.blockers });
      requestSync();
    } catch (e) {
      onAuthError(e);
    } finally {
      setBusy(null);
    }
  }

  const values = editor.values;
  const merged = draft && values ? draft.rows.map((r) => ({ ...r, ...(values[naturalKey(r.areaId, r.product)] ?? {}) })) : [];
  const remaining = draft && values ? completionBlockers(job, merged).length : null;

  return (
    <div className="pb-16">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="flex items-center gap-2 px-2 py-2">
          <Button variant="ghost" size="sm" onClick={back} aria-label="Back to jobs">
            ‹ Back
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{job.customer.name}</p>
            <p className="truncate text-xs text-slate-500">{job.address.street}</p>
          </div>
          {/* Verified once the office has locked this job's actuals, as on the office's job page. */}
          <StatusBadge
            status={job.status === 'completed' && draft?.syncState === 'locked' ? 'job.verified' : jobBadgeStatus({ status: job.status, scheduledStart: job.scheduledStart })}
          />
        </div>
      </header>

      <div className="space-y-3 p-3">
        {/* Clear direction first: what the estimator and the office want the crew to know. */}
        {hasNotes(notesOf(job)) ? (
          <Card aria-labelledby="crew-notes-title">
            <h2 id="crew-notes-title" className="mb-2 text-[19px] leading-snug font-extrabold text-ink">
              Notes for the crew
            </h2>
            <CrewNotesBlock notes={notesOf(job)} />
          </Card>
        ) : null}

        <Card>
          <p className="text-lg font-semibold text-slate-900">{job.address.street}</p>
          <p className="text-slate-700">
            {job.address.city} {job.address.zip}
          </p>
          <p className="mt-1 text-sm text-slate-600">{scheduleLine(job, today)}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a
              href={mapsUrl(job.address)}
              target="_blank"
              rel="noopener"
              className="inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-4 font-semibold text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50"
            >
              Directions
            </a>
            {telUrl(job.customer.phone) ? (
              <a
                href={telUrl(job.customer.phone)!}
                className="inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-4 font-semibold text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50"
              >
                Call {job.customer.name.split(' ')[0] || 'customer'}
              </a>
            ) : (
              <span className="inline-flex min-h-12 items-center justify-center rounded-xl px-4 text-sm text-slate-500 ring-1 ring-slate-200">No phone on file</span>
            )}
          </div>
        </Card>

        <StatusPanel job={job} online={online} busy={busy} remaining={remaining} onStart={() => changeStatus('start')} onUndo={() => changeStatus('undo')} onComplete={complete} />

        {message ? (
          <Alert tone={message.tone}>
            <p>{message.text}</p>
            {message.blockers?.length ? (
              <ul className="mt-1 list-disc pl-5">
                {message.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </Alert>
        ) : null}

        <WhatToBring job={job} />

        <h2 className="px-1 pt-2 text-sm font-semibold uppercase tracking-wide text-slate-500">Scope</h2>
        {job.areas.map((a) => (
          <AreaCard key={a.areaId} area={a} />
        ))}

        <BlowerDoorLink
          context={{ kind: 'job', id, label: [job.customer.name, job.address.street].filter(Boolean).join(', ') || null }}
          ownerId={profile.userId}
          hint="Test-out after the air sealing, saved to this job. Works with no signal."
        />

        <div className="flex items-center justify-between gap-2 px-1 pt-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Actuals</h2>
          {draft ? <SyncState draft={draft} online={online} /> : null}
        </div>
        {draft?.syncState === 'locked' ? <Alert tone="blue">{draft.lastError ?? 'The office verified this job. Actuals are read-only.'}</Alert> : null}
        {draft?.syncState === 'invalid' && draft.lastError ? <Alert tone="red">Fix before it can sync: {draft.lastError}</Alert> : null}
        {draft?.rows
          .filter((r) => r.changedElsewhere)
          .map((r) => (
            <Alert key={r.id} tone="amber">
              <span className="font-semibold">{rowTitle(job, r)}:</span> {r.changedElsewhere}
            </Alert>
          ))}
        {draft && values ? (
          <ActualsForm job={job} draft={draft} values={values} setRow={editor.setRow} />
        ) : (
          <p className="px-1 text-sm text-slate-500">Loading actuals…</p>
        )}
        {profile.role !== 'crew' ? <p className="px-1 text-xs text-slate-500">Costs and verification are on the office jobs page.</p> : null}
      </div>
    </div>
  );
}

/** "Attic · Cellulose" or "Whole job" for a stored actuals row. */
function rowTitle(job: CrewJob, r: { areaId: string | null; product: ProductCode | null }): string {
  if (r.areaId === null || r.product === null) return 'Whole job';
  const area = job.areas.find((a) => a.areaId === r.areaId)?.name;
  return `${area ? `${area} · ` : ''}${PRODUCT_LABELS[r.product]}`;
}

function scheduleLine(job: CrewJob, today: string): string {
  if (job.status === 'completed' && job.completedAt) return `Completed ${formatNyDateTime(job.completedAt)}`;
  if (job.status === 'in_progress' && job.startedAt) return `Started ${formatNyDateTime(job.startedAt)}`;
  if (!job.scheduledStart) return 'Not scheduled yet';
  const days = job.scheduledDays ? ` · planned ${num(job.scheduledDays, 1)} day${job.scheduledDays === 1 ? '' : 's'}` : '';
  return `${dayLabel(job.scheduledStart, today)}${days}`;
}

function StatusPanel({
  job,
  online,
  busy,
  remaining,
  onStart,
  onUndo,
  onComplete,
}: {
  job: CrewJob;
  online: boolean;
  busy: null | 'start' | 'undo' | 'complete';
  remaining: number | null;
  onStart: () => void;
  onUndo: () => void;
  onComplete: () => void;
}) {
  if (job.status !== 'scheduled' && job.status !== 'in_progress') return null;
  return (
    <Card>
      {job.status === 'scheduled' ? (
        <Button size="lg" className="w-full" onClick={onStart} disabled={!online || busy !== null} aria-busy={busy === 'start'}>
          {busy === 'start' ? 'Starting…' : 'Start job'}
        </Button>
      ) : (
        <div className="space-y-2">
          <Button size="lg" className="w-full" onClick={onComplete} disabled={!online || busy !== null} aria-busy={busy === 'complete'}>
            {busy === 'complete' ? 'Syncing and completing…' : 'Complete job'}
          </Button>
          {remaining ? <p className="text-center text-sm text-slate-600">{remaining} item{remaining === 1 ? '' : 's'} of actuals still to fill in.</p> : null}
          <Button variant="ghost" size="sm" className="w-full" onClick={onUndo} disabled={!online || busy !== null}>
            {busy === 'undo' ? 'Undoing…' : 'Undo start'}
          </Button>
        </div>
      )}
      {!online ? (
        <p className="mt-2 text-center text-sm text-amber-800">Starting and completing a job need signal. Your actuals are saved on this phone.</p>
      ) : null}
    </Card>
  );
}

/** This job's load list: every material of its scope, summed over the areas and rounded up. */
function WhatToBring({ job }: { job: CrewJob }) {
  const lines = jobLoadList(job);
  const days = jobDays(job);
  return (
    <Card aria-labelledby="what-to-bring-title">
      <h2 id="what-to-bring-title" className="text-[19px] leading-snug font-extrabold text-ink">
        What to bring
      </h2>
      <p className="mt-0.5 text-[15px] leading-snug font-medium text-ink-2">
        What the estimate calculated for this job, added up over its areas and rounded up to whole units
        {days > 1 ? `. A ${days}-day job: it all loads on day 1.` : '.'}
      </p>
      {lines.length ? (
        <ul className="mt-2 divide-y divide-line">
          {lines.map((l) => (
            <li key={l.key} className="flex min-h-12 items-center justify-between gap-3 py-2">
              <span className="min-w-0 text-[17px] leading-snug font-bold text-ink [overflow-wrap:anywhere]">{l.name}</span>
              <span className={l.qty === null ? 'shrink-0 text-right text-[15px] font-semibold text-ink-2' : 'gauge-m shrink-0 text-right text-[22px] text-ink'}>{qtyText(l)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[15px] font-medium text-ink-2">No materials in the signed scope.</p>
      )}
    </Card>
  );
}

function AreaCard({ area }: { area: CrewArea }) {
  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-slate-900">{area.name}</h3>
        <span className="text-sm text-slate-600">
          {JOB_TYPE_LABELS[area.jobType]} · {num(area.sqft)} sq ft · {ACCESS_LABELS[area.accessLevel]} access
        </span>
      </div>
      {area.hazards.length ? (
        <div className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200" role="note">
          <p className="font-semibold text-red-800">Hazards: {area.hazards.join(', ')}</p>
          {area.hazardDisposition ? <p className="mt-1">{area.hazardDisposition}</p> : null}
        </div>
      ) : null}
      {area.removalNeeded ? <p className="mt-2 text-sm font-medium text-slate-800">Remove the existing insulation first.</p> : null}
      {area.prepNotes ? (
        <p className="mt-2 whitespace-pre-line text-sm text-slate-700">
          <span className="font-medium">Prep: </span>
          {area.prepNotes}
        </p>
      ) : null}
      {area.scope.length ? (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {area.scope.map((l, i) => (
            <li key={`${l.product}-${l.kind}-${i}`} className="flex items-baseline justify-between gap-3 py-2">
              <span className="text-slate-800">{l.description}</span>
              <span className="shrink-0 tabular-nums text-slate-600">
                {l.kind === 'material'
                  ? l.qty !== null
                    ? `${num(l.qty, 1)} ${l.unit ? UNIT_LABELS[l.unit] : ''}`.trim()
                    : '—'
                  : l.hours !== null
                    ? `${num(l.hours, 1)} person-hrs`
                    : '—'}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-slate-500">No installed scope listed for this area.</p>
      )}
    </Card>
  );
}

function SyncState({ draft, online }: { draft: LocalActuals; online: boolean }) {
  if (draft.syncState === 'pending' || draft.syncState === 'error') {
    return (
      <Tag tone="warn" icon={online ? RefreshCw : Smartphone}>
        {online ? 'Syncing…' : 'Saved on phone'}
      </Tag>
    );
  }
  return <ActualsTag state={draft.syncState} />;
}
