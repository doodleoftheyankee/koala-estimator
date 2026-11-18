import { describe, expect, it } from 'vitest';
import { jobBadgeStatus, STATUS_META } from '@/components/daymark/StatusBadge';
import { JOB_STATUSES } from '@/lib/jobs/status';
import {
  actualsLine,
  byStage,
  historyGroupOf,
  JOB_STAGES,
  jobKpis,
  jobsHref,
  jobStage,
  parseStage,
  sortByCompletion,
  stageBadge,
  STAGE_LABELS,
  type StageInput,
} from './jobs';

const job = (over: Partial<StageInput> = {}): StageInput => ({ status: 'scheduled', scheduledStart: null, actualsCount: 0, verifiedCount: 0, ...over });

describe('jobStage', () => {
  it('splits "scheduled" into To schedule and Scheduled by the start date (UX-02)', () => {
    expect(jobStage(job())).toBe('to_schedule');
    expect(jobStage(job({ scheduledStart: '2026-11-20' }))).toBe('scheduled');
  });

  it('splits completed jobs into Needs check and Verified', () => {
    expect(jobStage(job({ status: 'completed' }))).toBe('needs_check');
    expect(jobStage(job({ status: 'completed', actualsCount: 3, verifiedCount: 2 }))).toBe('needs_check');
    expect(jobStage(job({ status: 'completed', actualsCount: 3, verifiedCount: 3 }))).toBe('verified');
    expect(jobStage(job({ status: 'in_progress' }))).toBe('in_progress');
    expect(jobStage(job({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('always agrees with the badge the job shows, and uses its words', () => {
    for (const status of JOB_STATUSES)
      for (const scheduledStart of [null, '2026-11-20'])
        for (const [actualsCount, verifiedCount] of [
          [0, 0],
          [2, 1],
          [2, 2],
        ] as const) {
          const j = { status, scheduledStart, actualsCount, verifiedCount };
          expect(stageBadge(jobStage(j))).toBe(jobBadgeStatus(j));
        }
    for (const s of JOB_STAGES) expect(STAGE_LABELS[s]).toBe(STATUS_META[stageBadge(s)].label);
  });
});

describe('byStage and order', () => {
  it('puts every job in exactly one stage, keeping order', () => {
    const jobs = [
      { id: 'a', ...job() },
      { id: 'b', ...job({ scheduledStart: '2026-11-20' }) },
      { id: 'c', ...job() },
      { id: 'd', ...job({ status: 'completed', actualsCount: 1, verifiedCount: 1 }) },
    ].map((j) => ({ ...j, stage: jobStage(j) }));
    const g = byStage(jobs);
    expect(g.to_schedule.map((j) => j.id)).toEqual(['a', 'c']);
    expect(g.scheduled.map((j) => j.id)).toEqual(['b']);
    expect(g.verified.map((j) => j.id)).toEqual(['d']);
    expect(Object.values(g).flat()).toHaveLength(jobs.length);
  });

  it('sorts finished jobs newest first', () => {
    const rows = [{ completedAt: '2026-11-01T00:00:00Z' }, { completedAt: null }, { completedAt: '2026-11-17T00:00:00Z' }];
    expect(sortByCompletion(rows).map((r) => r.completedAt)).toEqual(['2026-11-17T00:00:00Z', '2026-11-01T00:00:00Z', null]);
  });
});

describe('filters and links', () => {
  it('reads ?stage=', () => {
    expect(parseStage('needs_check')).toBe('needs_check');
    expect(parseStage(['verified', 'x'])).toBe('verified');
    expect(parseStage('completed')).toBeNull();
    expect(parseStage(undefined)).toBeNull();
  });

  it('keeps ?all= working beside the stage', () => {
    expect(jobsHref({ stage: null, all: null })).toBe('/jobs');
    expect(jobsHref({ stage: null, all: 'verified' })).toBe('/jobs?all=verified');
    expect(jobsHref({ stage: 'cancelled', all: 'cancelled' })).toBe('/jobs?stage=cancelled&all=cancelled');
    expect(historyGroupOf('verified')).toBe('verified');
    expect(historyGroupOf('to_schedule')).toBeNull();
  });
});

describe('jobKpis', () => {
  it('counts and adds only the jobs of each open stage', () => {
    const k = jobKpis([
      { stage: 'to_schedule', price: 3350 },
      { stage: 'to_schedule', price: null },
      { stage: 'scheduled', price: 4780.5 },
      { stage: 'scheduled', price: 1000 },
      { stage: 'needs_check', price: 5060 },
      { stage: 'verified', price: 9999 },
      { stage: 'cancelled', price: 9999 },
    ]);
    expect(k.to_schedule).toEqual({ count: 2, total: 3350, unpriced: 1 });
    expect(k.scheduled).toEqual({ count: 2, total: 5780.5, unpriced: 0 });
    expect(k.needs_check).toEqual({ count: 1, total: 5060, unpriced: 0 });
    expect(k.in_progress).toEqual({ count: 0, total: null, unpriced: 0 });
  });
});

describe('actualsLine', () => {
  it('says how many rows are checked', () => {
    expect(actualsLine({ actualsCount: 0, verifiedCount: 0 })).toBe('No actuals yet');
    expect(actualsLine({ actualsCount: 3, verifiedCount: 1 })).toBe('1 of 3 rows checked');
    expect(actualsLine({ actualsCount: 1, verifiedCount: 0 })).toBe('0 of 1 row checked');
    expect(actualsLine({ actualsCount: 3, verifiedCount: 3 })).toBe('All 3 rows checked');
    expect(actualsLine({ actualsCount: 1, verifiedCount: 1 })).toBe('All 1 row checked');
  });
});
