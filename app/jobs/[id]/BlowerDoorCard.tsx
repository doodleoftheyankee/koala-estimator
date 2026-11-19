// The job's blower door test on the office job page (quiet register): the newest test-in and
// test-out as recorded, the reduction, the tier and rebate under the program saved with the
// readings (and the cost cap when a price was given), the ventilation check and every earlier
// reading. Worked out by lib/blowerdoor from the saved CFM50s, never again from a later exponent.
import { z } from 'zod';
import {
  achText,
  capNote,
  cfmText,
  headlineWords,
  jobBlowerDoor,
  KIND_LABELS,
  paText,
  parseBlowerDoorSettings,
  pctText,
  savedTestSchema,
  SETTINGS_KEY,
  ventilationWords,
  type SavedTest,
} from '@/lib/blowerdoor';
import { blowerDoorHref } from '@/lib/offline/blowerDoorCore';
import { formatDateTime, formatMoney, num } from '@/lib/format';
import { Banner, CircleCheck, Icon, OctagonAlert, Tag, Wind } from '@/components/daymark';
import { FactStrip, TABLE } from '@/components/office';
import type { createClient } from '@/lib/supabase/server';

type Db = Awaited<ReturnType<typeof createClient>>;

const SELECT = `id, job_id, estimate_id, kind, cfm, pa, exponent, cfm50, program_key, program, air_sealing_cost,
  bas_audit, volume, occupants, stories, n_factor, recorded_by, recorded_at, recorder:profiles!blower_door_tests_recorded_by_fkey(full_name)`;

const rowSchema = z.object({ recorder: z.preprocess((v) => (Array.isArray(v) ? (v[0] ?? null) : v), z.object({ full_name: z.string() }).nullable().optional()) }).loose();

/** The job's readings, and the readings taken on its estimate before it was a job. */
async function loadReadings(db: Db, jobId: string, estimateId: string | null): Promise<{ tests: SavedTest[]; gauge: string; error: string | null }> {
  let q = db.from('blower_door_tests').select(SELECT).order('recorded_at', { ascending: false });
  q = estimateId ? q.or(`job_id.eq.${jobId},and(job_id.is.null,estimate_id.eq.${estimateId})`) : q.eq('job_id', jobId);
  const [res, settings] = await Promise.all([q, db.from('app_settings').select('value').eq('key', SETTINGS_KEY).maybeSingle()]);
  const gauge = parseBlowerDoorSettings(settings.data?.value ?? null).settings.gauge;
  if (res.error) return { tests: [], gauge, error: res.error.message };
  const tests: SavedTest[] = [];
  for (const raw of (res.data ?? []) as unknown[]) {
    const extra = rowSchema.safeParse(raw);
    const parsed = savedTestSchema.safeParse({ ...(raw as object), recorded_by_name: extra.success ? (extra.data.recorder?.full_name ?? null) : null });
    if (parsed.success) tests.push(parsed.data);
  }
  return { tests, gauge, error: null };
}

const readLine = (t: SavedTest) => `Read ${cfmText(t.cfm)} CFM at ${paText(t.pa)} Pa · n ${num(t.exponent, 3)}`;
const byLine = (t: SavedTest) => `${formatDateTime(t.recorded_at)}${t.recorded_by_name ? ` · ${t.recorded_by_name}` : ''}`;

export async function BlowerDoorCard({ db, jobId, estimateId, label }: { db: Db; jobId: string; estimateId: string | null; label: string }) {
  const { tests, gauge, error } = await loadReadings(db, jobId, estimateId);
  const bd = jobBlowerDoor(tests, gauge);
  const e = bd.evaluation;
  const href = blowerDoorHref({ kind: 'job', id: jobId, label });

  return (
    <section aria-labelledby="blower-door" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="blower-door" className="flex items-center gap-2 text-lg font-semibold text-slate-900">
          <Icon icon={Wind} size="s" />
          Blower door test
        </h2>
        <a href={href} className="inline-flex min-h-12 items-center rounded-control px-1 font-bold text-ink underline underline-offset-4 hover:bg-sunken">
          Open the blower door tool
        </a>
      </div>
      {error ? (
        <Banner tone="bad" title="The blower door readings did not load.">
          {error}
        </Banner>
      ) : null}
      {!error && !e ? (
        <p className="plate p-4 text-[16px] font-medium text-ink-2">
          No blower door readings yet. The estimator records the test-in on the estimate; the crew records the test-out on the job, on their phone.
        </p>
      ) : null}
      {e ? <Result e={e} testIn={bd.testIn} testOut={bd.testOut} earlier={bd.earlier} /> : null}
    </section>
  );
}

function Result({
  e,
  testIn,
  testOut,
  earlier,
}: {
  e: NonNullable<ReturnType<typeof jobBlowerDoor>['evaluation']>;
  testIn: SavedTest | null;
  testOut: SavedTest | null;
  earlier: SavedTest[];
}) {
  const w = headlineWords(e);
  const vent = e.ventilation && e.bas.value !== null ? ventilationWords(e.ventilation, e.bas.value, e.bas, e.program) : null;
  const tierFact =
    e.program && e.rebate && e.tiers
      ? e.tiers.hit
        ? `${num(e.tiers.hit.reductionPct, 1)}% tier · ${formatMoney(e.rebate.amount)}${capNote(e)}`
        : `Below ${num(e.tiers.rows[0]?.tier.reductionPct ?? 0, 1)}% · no rebate`
      : e.program
        ? 'Waiting for the test-out'
        : 'No program saved with the readings';
  const ventFact = vent ? (vent.tone === 'ok' ? 'OK, above BAS' : vent.tone === 'warn' ? 'Recommend ventilation' : 'Install ventilation') : e.bas.value !== null ? 'Waiting for the test-out' : 'No BAS given';
  return (
    <>
      <div className={e.headline.kind === 'tier' ? 'rounded-plate border-solid border-[length:var(--bw)] border-ok bg-ok-fill px-4 py-3' : e.headline.kind === 'below' ? 'rounded-plate border-solid border-[length:var(--bw)] border-bad bg-bad-fill px-4 py-3' : 'plate px-4 py-3'}>
        <p className={`flex items-center gap-2 sign-label [--sign-size:13px] ${w.tone === 'pass' ? 'text-ok' : w.tone === 'fail' ? 'text-bad' : 'text-ink-2'}`} data-testid="job-bd-badge">
          {w.tone === 'pass' ? <Icon icon={CircleCheck} size="s" /> : w.tone === 'fail' ? <Icon icon={OctagonAlert} size="s" /> : null}
          {w.badge}
        </p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-3">
          <span className="gauge text-[44px] text-ink">{w.big}</span>
          {w.unit ? <span className="sign-label text-ink [--sign-size:12px]">{w.unit}</span> : null}
          <span className="text-[16px] font-bold text-ink">{w.line}</span>
        </p>
        {e.program ? <p className="mt-1 text-[15px] font-medium text-ink-2">{e.program.name}, as saved with the readings.</p> : null}
      </div>
      <FactStrip
        title="Blower door figures"
        facts={[
          { key: 'in', label: 'Test-in', value: testIn ? <Reading t={testIn} /> : 'Not recorded' },
          { key: 'out', label: 'Test-out', value: testOut ? <Reading t={testOut} /> : 'Not recorded' },
          {
            key: 'red',
            label: 'Reduction',
            value: e.reductionPct !== null ? (
              <span className="flex flex-col gap-1">
                <span className="gauge-m text-[22px]">{pctText(e.reductionPct)}</span>
                <span>{tierFact}</span>
              </span>
            ) : (
              tierFact
            ),
          },
          {
            key: 'vent',
            label: 'Ventilation',
            value: (
              <span className="flex flex-col gap-1">
                <span>{ventFact}</span>
                {e.bas.value !== null ? <span className="text-ink-2">BAS {cfmText(e.bas.value)} CFM50 ({e.bas.source === 'audit' ? 'from audit' : 'estimated'})</span> : null}
                {e.ach50Pre !== null && e.ach50Post !== null ? <span className="text-ink-2">ACH50 {achText(e.ach50Pre)} → {achText(e.ach50Post)}</span> : null}
              </span>
            ),
          },
        ]}
      />
      {vent ? (
        <Banner tone={vent.tone} live={false}>
          <span data-testid="job-bd-ventilation">{vent.text}</span>
        </Banner>
      ) : null}
      <div className="plate overflow-x-auto p-0">
        <table className={`${TABLE.table} min-w-[640px]`}>
          <thead>
            <tr className={TABLE.headRow}>
              <th scope="col" className={TABLE.th}>Reading</th>
              <th scope="col" className={`${TABLE.th} ${TABLE.thNum}`}>CFM50</th>
              <th scope="col" className={TABLE.th}>As read</th>
              <th scope="col" className={TABLE.th}>Recorded</th>
              <th scope="col" className={TABLE.th}>Counts</th>
            </tr>
          </thead>
          <tbody className={TABLE.body}>
            {[testIn, testOut, ...earlier]
              .filter((t): t is SavedTest => t !== null)
              .map((t) => {
                const current = t === testIn || t === testOut;
                return (
                  <tr key={t.id} className={TABLE.row}>
                    <td className={TABLE.td}>
                      {KIND_LABELS[t.kind]}
                      {t.job_id ? '' : ' (estimate)'}
                    </td>
                    <td className={`${TABLE.td} ${TABLE.tdNum} gauge-m text-[20px]`}>{cfmText(t.cfm50)}</td>
                    <td className={TABLE.td}>{readLine(t)}</td>
                    <td className={TABLE.td}>{byLine(t)}</td>
                    <td className={TABLE.td}>
                      {current ? (
                        <Tag tone="ok" icon={CircleCheck}>
                          Newest
                        </Tag>
                      ) : (
                        <Tag tone="draft">Earlier</Tag>
                      )}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Reading({ t }: { t: SavedTest }) {
  return (
    <span className="flex flex-col gap-1">
      <span className="gauge-m text-[22px]">{cfmText(t.cfm50)} CFM50</span>
      <span className="text-ink-2">{readLine(t)}</span>
      <span className="text-ink-2">{byLine(t)}</span>
    </span>
  );
}
