import { describe, expect, it } from 'vitest';
import { allowedTransitions, groupForCrew, groupForOffice, isJobStatus, officeGroup, type JobStatus } from './status';

describe('allowedTransitions', () => {
  it('lets crews start, complete and un-start their jobs', () => {
    expect(allowedTransitions('scheduled', 'crew')).toEqual(['in_progress']);
    expect(allowedTransitions('in_progress', 'crew')).toEqual(['completed', 'scheduled']);
    expect(allowedTransitions('completed', 'crew')).toEqual([]);
    expect(allowedTransitions('cancelled', 'crew')).toEqual([]);
  });
  it('lets the office also reopen and cancel', () => {
    expect(allowedTransitions('scheduled', 'office')).toEqual(['in_progress', 'cancelled']);
    expect(allowedTransitions('in_progress', 'owner')).toEqual(['completed', 'scheduled', 'cancelled']);
    expect(allowedTransitions('completed', 'office')).toEqual(['in_progress', 'cancelled']);
    expect(allowedTransitions('cancelled', 'owner')).toEqual([]);
  });
  it('gives estimators nothing', () => {
    expect(allowedTransitions('scheduled', 'estimator')).toEqual([]);
  });
  it('recognizes statuses', () => {
    expect(isJobStatus('completed')).toBe(true);
    expect(isJobStatus('done')).toBe(false);
    expect(isJobStatus(null)).toBe(false);
  });
});

describe('office grouping', () => {
  const job = (status: JobStatus, actualsCount = 0, verifiedCount = 0) => ({ status, actualsCount, verifiedCount });
  it('splits completed jobs by verification', () => {
    expect(officeGroup(job('completed', 0, 0))).toBe('awaiting_verification');
    expect(officeGroup(job('completed', 3, 2))).toBe('awaiting_verification');
    expect(officeGroup(job('completed', 3, 3))).toBe('verified');
    expect(officeGroup(job('scheduled'))).toBe('scheduled');
    expect(officeGroup(job('in_progress', 2, 0))).toBe('in_progress');
    expect(officeGroup(job('cancelled', 2, 2))).toBe('cancelled');
  });
  it('groups every job exactly once', () => {
    const jobs = [job('scheduled'), job('completed', 1, 1), job('completed', 1, 0), job('cancelled'), job('in_progress')];
    const g = groupForOffice(jobs);
    expect(Object.values(g).flat()).toHaveLength(jobs.length);
    expect(g.verified).toHaveLength(1);
    expect(g.awaiting_verification).toHaveLength(1);
  });
});

describe('crew grouping', () => {
  const j = (id: string, status: JobStatus, over: Partial<{ scheduledStart: string | null; startedAt: string | null; completedAt: string | null }> = {}) => ({
    id,
    status,
    scheduledStart: null,
    startedAt: null,
    completedAt: null,
    ...over,
  });
  it('sorts each section and hides cancelled jobs', () => {
    const g = groupForCrew([
      j('later', 'scheduled', { scheduledStart: '2026-10-25' }),
      j('unscheduled', 'scheduled'),
      j('overdue', 'scheduled', { scheduledStart: '2026-10-18' }),
      j('soon', 'scheduled', { scheduledStart: '2026-10-21' }),
      j('started2', 'in_progress', { startedAt: '2026-10-20T14:00:00Z' }),
      j('started1', 'in_progress', { startedAt: '2026-10-19T14:00:00Z' }),
      j('startedUnknown', 'in_progress'),
      j('done-old', 'completed', { completedAt: '2026-10-10T20:00:00Z' }),
      j('done-new', 'completed', { completedAt: '2026-10-19T20:00:00Z' }),
      j('done-unknown', 'completed'),
      j('gone', 'cancelled'),
    ]);
    expect(g.in_progress.map((x) => x.id)).toEqual(['started1', 'started2', 'startedUnknown']);
    expect(g.upcoming.map((x) => x.id)).toEqual(['overdue', 'soon', 'later', 'unscheduled']);
    expect(g.recent.map((x) => x.id)).toEqual(['done-new', 'done-old', 'done-unknown']);
  });
});
