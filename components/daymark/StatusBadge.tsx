// Status tags: icon + word + fixed colour, never colour alone. ONE vocabulary for the whole app.
//
//   Quotes:  Draft · Sent · Viewed · Signed · Declined · Expired · Lost
//   Jobs:    To schedule · Scheduled · In progress · Done · Needs check · Verified · Cancelled
//
// Colours: grey = draft or closed out, blue = waiting on the customer, violet = the customer
// looked, green = won or done, amber = needs your action, red = lost, declined or cancelled.
// Signed is the only solid tag, because it is final. Sync state is NOT a status: use
// SyncIndicator for that.
//
//   <StatusBadge status="viewed" />
//   <StatusBadge status="job.in_progress" />
//   <StatusBadge status={jobBadgeStatus(job)} />
//   <Tag tone="warn" icon={CloudUpload}>Not synced</Tag>    any other tag in the same shape
import type { ReactNode } from 'react';
import { cx } from './cx';
import {
  Ban,
  CalendarCheck,
  CalendarPlus,
  Check,
  CircleCheck,
  ClipboardCheck,
  Clock,
  Eye,
  Hammer,
  Icon,
  PencilLine,
  Send,
  ShieldCheck,
  ThumbsDown,
  X,
  type LucideIcon,
} from './icons';

export type TagTone = 'draft' | 'line' | 'info' | 'viewed' | 'signed' | 'ok' | 'warn' | 'bad';

const TONE: Record<TagTone, string> = {
  draft: 'bg-draft-fill text-ink-2',
  line: 'bg-surface text-ink shadow-[inset_0_0_0_var(--bw)_var(--edge)]',
  info: 'bg-info-fill text-info',
  viewed: 'bg-viewed-fill text-viewed',
  signed: 'bg-ok text-on-ok',
  ok: 'bg-ok-fill text-ok',
  warn: 'bg-warn-fill text-warn',
  bad: 'bg-bad-fill text-bad',
};

/** A 28px tag: icon + caps word on a tinted fill. */
export function Tag({ tone, icon, children, className, title }: { tone: TagTone; icon?: LucideIcon; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-7 max-w-full shrink-0 items-center gap-1.5 whitespace-nowrap rounded-tag pr-2.5 pl-2 font-num text-[12.5px] leading-none font-bold tracking-[0.06em] uppercase [font-stretch:112%]',
        TONE[tone],
        className,
      )}
    >
      {icon ? <Icon icon={icon} size="xs" /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

export const QUOTE_STATUSES = ['draft', 'sent', 'viewed', 'signed', 'declined', 'expired', 'lost'] as const;
export type QuoteBadgeStatus = (typeof QUOTE_STATUSES)[number];

export const JOB_BADGE_STATUSES = [
  'job.to_schedule',
  'job.scheduled',
  'job.in_progress',
  'job.completed',
  'job.needs_check',
  'job.verified',
  'job.cancelled',
] as const;
export type JobBadgeStatus = (typeof JOB_BADGE_STATUSES)[number];

export type BadgeStatus = QuoteBadgeStatus | JobBadgeStatus;

export interface StatusMeta {
  label: string;
  icon: LucideIcon;
  tone: TagTone;
  /** One line for help text and the /design page. */
  means: string;
}

export const STATUS_META: Record<BadgeStatus, StatusMeta> = {
  draft: { label: 'Draft', icon: PencilLine, tone: 'draft', means: 'Not sent to the customer yet' },
  sent: { label: 'Sent', icon: Send, tone: 'info', means: 'Waiting for the customer to open it' },
  viewed: { label: 'Viewed', icon: Eye, tone: 'viewed', means: 'The customer opened it, not signed yet' },
  signed: { label: 'Signed', icon: Check, tone: 'signed', means: 'The customer signed: won' },
  declined: { label: 'Declined', icon: ThumbsDown, tone: 'bad', means: 'The customer said no' },
  expired: { label: 'Expired', icon: Clock, tone: 'draft', means: 'The price hold ran out' },
  lost: { label: 'Lost', icon: X, tone: 'bad', means: 'Marked lost by the office' },
  'job.to_schedule': { label: 'To schedule', icon: CalendarPlus, tone: 'warn', means: 'Signed, needs a date' },
  'job.scheduled': { label: 'Scheduled', icon: CalendarCheck, tone: 'info', means: 'Has a date and a crew' },
  'job.in_progress': { label: 'In progress', icon: Hammer, tone: 'line', means: 'The crew has started' },
  'job.completed': { label: 'Done', icon: CircleCheck, tone: 'ok', means: 'The crew finished' },
  'job.needs_check': { label: 'Needs check', icon: ClipboardCheck, tone: 'warn', means: 'Done, the office checks the numbers' },
  'job.verified': { label: 'Verified', icon: ShieldCheck, tone: 'ok', means: 'Done and checked' },
  'job.cancelled': { label: 'Cancelled', icon: Ban, tone: 'bad', means: 'Will not go ahead' },
};

export function isBadgeStatus(s: unknown): s is BadgeStatus {
  return typeof s === 'string' && s in STATUS_META;
}

/**
 * The badge for a job, from the job statuses in lib/jobs/status.ts. A completed job is
 * "Needs check" until every actuals row is verified; a scheduled job with no date is
 * "To schedule". Pass what you know; the database stays the authority on the status.
 */
export function jobBadgeStatus(job: {
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  scheduledStart?: string | null;
  actualsCount?: number;
  verifiedCount?: number;
}): JobBadgeStatus {
  switch (job.status) {
    case 'scheduled':
      return job.scheduledStart === null ? 'job.to_schedule' : 'job.scheduled';
    case 'in_progress':
      return 'job.in_progress';
    case 'cancelled':
      return 'job.cancelled';
    case 'completed':
      if (job.actualsCount === undefined) return 'job.completed';
      return job.actualsCount > 0 && (job.verifiedCount ?? 0) >= job.actualsCount ? 'job.verified' : 'job.needs_check';
  }
}

/** The one status badge. */
export function StatusBadge({ status, className }: { status: BadgeStatus; className?: string }) {
  const m = STATUS_META[status];
  return (
    <Tag tone={m.tone} icon={m.icon} className={className}>
      {m.label}
    </Tag>
  );
}
