// Empty, loading and sync states.
//
//   <EmptyState icon={HousePlus} title="No estimates on this phone yet"
//     hint="Start one at the door, or look up a roof first." action={<ButtonLink …>New estimate</ButtonLink>} />
//   <LoadingSteps steps={[{ label: 'Finding 14 Main St', state: 'done' }, { label: 'Reading the roof', state: 'doing' }]} />
//   <ProgressBar value={2} max={4} label="Uploading photos" />
//   <Skeleton className="h-4 w-2/3" />
//   <SyncIndicator state="pending" pending={2} lastSyncedAt={iso} onClick={openSyncSheet} />
//
// Loading is never a bare spinner: name the steps. Sync state is shown ONCE, in the app header,
// and never as a status badge.
import type { ReactNode } from 'react';
import { relativeTime } from '@/lib/format';
import { cx } from './cx';
import { Check, Circle, CloudAlert, CloudCheck, CloudOff, CloudUpload, Icon, LoaderCircle, RefreshCw, TriangleAlert, type LucideIcon } from './icons';

export function EmptyState({ icon, title, hint, action, className }: { icon: LucideIcon; title: ReactNode; hint?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex flex-col items-start gap-3 py-6', className)}>
      <span className="text-ink">
        <Icon icon={icon} size="xl" />
      </span>
      <p className="text-[20px] leading-snug font-extrabold text-ink">{title}</p>
      {hint ? <p className="text-[16px] font-medium text-ink-2">{hint}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}

export type StepState = 'done' | 'doing' | 'todo' | 'failed';

/** Named loading steps (a checklist), so people know what is happening. */
export function LoadingSteps({ steps, className }: { steps: ReadonlyArray<{ label: ReactNode; state: StepState }>; className?: string }) {
  return (
    <ol className={cx('space-y-2', className)}>
      {steps.map((s, i) => (
        <li key={i} className={cx('flex items-center gap-2.5 text-[16px] font-semibold', s.state === 'todo' ? 'text-ink-3' : s.state === 'failed' ? 'text-bad' : 'text-ink')}>
          <Icon
            icon={s.state === 'done' ? Check : s.state === 'doing' ? LoaderCircle : s.state === 'failed' ? TriangleAlert : Circle}
            size="s"
            className={s.state === 'doing' ? 'animate-spin [animation-duration:1.6s]' : undefined}
          />
          <span>{s.label}</span>
          <span className="sr-only">{s.state === 'done' ? '(done)' : s.state === 'doing' ? '(working)' : s.state === 'failed' ? '(failed)' : '(waiting)'}</span>
        </li>
      ))}
    </ol>
  );
}

/** A determinate ink progress bar (only when the step count is known). */
export function ProgressBar({ value, max, label, className }: { value: number; max: number; label: string; className?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} className={cx('h-2 w-full overflow-hidden rounded-full bg-track shadow-[inset_0_0_0_2px_var(--track-edge)]', className)}>
      <div className="h-full rounded-full bg-ink transition-[width] duration-[var(--t-move)]" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A skeleton bar with a slow shimmer (none with reduced motion). Size it with className. */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cx(
        'block h-3.5 rounded-[7px] bg-draft-fill bg-[linear-gradient(90deg,transparent_0,var(--sunken)_40%,transparent_80%)] bg-[length:300%_100%] animate-[dm-shimmer_1.8s_linear_infinite]',
        className,
      )}
    />
  );
}

export type SyncState = 'synced' | 'syncing' | 'pending' | 'offline' | 'conflict' | 'error';

const SYNC: Record<SyncState, { icon: LucideIcon; tone: string; text: (p: { pending?: number; last?: string | null; now?: number }) => string }> = {
  synced: { icon: CloudCheck, tone: 'text-ok', text: ({ last, now }) => (last ? `Synced ${relativeTime(last, now)}` : 'Synced') },
  syncing: { icon: RefreshCw, tone: 'text-ink-2', text: () => 'Syncing…' },
  pending: { icon: CloudUpload, tone: 'text-warn', text: ({ pending }) => (pending ? `${pending} waiting to sync` : 'Not synced') },
  offline: { icon: CloudOff, tone: 'text-warn', text: ({ pending }) => (pending ? `Offline · ${pending} waiting` : 'Offline') },
  conflict: { icon: TriangleAlert, tone: 'text-bad', text: () => 'Needs a look' },
  error: { icon: CloudAlert, tone: 'text-bad', text: () => 'Sync failed' },
};

/** The one sync indicator (app header). A button when onClick is given (open the sync sheet). */
export function SyncIndicator({
  state,
  pending,
  lastSyncedAt,
  now,
  onClick,
  compact = false,
  className,
}: {
  state: SyncState;
  pending?: number;
  lastSyncedAt?: string | null;
  /** For tests and screenshots; defaults to the current time. */
  now?: number;
  onClick?: () => void;
  /** Icon only (a 48px button with the words as its name). */
  compact?: boolean;
  className?: string;
}) {
  const s = SYNC[state];
  const words = s.text({ pending, last: lastSyncedAt, now });
  const inner = (
    <>
      <span className={s.tone}>
        <Icon icon={s.icon} size="s" className={state === 'syncing' ? 'animate-spin [animation-duration:1.6s]' : undefined} />
      </span>
      <span className={compact ? 'sr-only' : 'truncate'}>{words}</span>
    </>
  );
  const cls = cx('inline-flex min-w-0 items-center gap-1.5 text-[15px] font-bold text-ink-2', compact && 'h-12 w-12 justify-center', className);
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={cx(cls, 'min-h-12 rounded-control px-2 hover:bg-sunken')} title={compact ? words : undefined}>
        {inner}
      </button>
    );
  }
  return (
    <span role="status" className={cls}>
      {inner}
    </span>
  );
}
