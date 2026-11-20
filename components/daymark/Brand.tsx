// The product mark and the step track.
//
//   <Monogram />                     the KE tile: condensed Archivo on ink, a hi-vis daymark corner
//   <StepTrack steps={['Customer', 'Areas', 'Options', 'Send']} current={1} />
//   <StepTrack … label="Estimate steps" onStep={go} badges={{ 2: { count: '2', label: '2 to explain' } }} />
//
// The mark belongs to the product, not to a franchise. A franchise's own colour appears only in
// its logo tile on the quote and in its PDF letterhead.
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Icon, TriangleAlert } from './icons';

/** label: the accessible name; pass "" when the product name is written next to it (decorative). */
export function Monogram({ size = 44, className, label = 'Koala Estimator' }: { size?: number; className?: string; label?: string }) {
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
      className={cx('relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[22%] bg-ink text-on-ink', className)}
      style={{ width: size, height: size }}
    >
      <span className="gauge leading-none" style={{ fontSize: size * 0.48 }} aria-hidden>
        KE
      </span>
      {/* The daymark: a hi-vis triangle in the top-right corner. */}
      <span aria-hidden className="absolute top-0 right-0 bg-hivis" style={{ width: size * 0.32, height: size * 0.32, clipPath: 'polygon(0 0, 100% 0, 100% 100%)' }} />
    </span>
  );
}

export interface StepBadge {
  /** What shows over the end of the step's bar: a count such as "2". */
  count: ReactNode;
  /** The same for screen readers, read after the step's name: "2 to explain". */
  label: string;
}

/**
 * The step track: done steps are ink, the current step is ink with a ring, upcoming steps use the
 * track (hollow in Sun+). Give it `onStep` to make each step a 48px button (aria-current="step"),
 * and `badges` to flag a step that needs a look (a warning count over the end of its bar).
 * `columns` sets grid-template-columns, so long step names can take more room on a phone.
 */
export function StepTrack({
  steps,
  current,
  className,
  label = 'Steps',
  onStep,
  badges,
  columns,
  done,
}: {
  steps: readonly string[];
  current: number;
  className?: string;
  label?: string;
  onStep?: (index: number) => void;
  badges?: Partial<Record<number, StepBadge>>;
  columns?: string;
  /**
   * Which steps are complete, when the screen knows. With steps you can tap (onStep), a step
   * before the current one is not done just because it was passed, so pass this. Without it,
   * every step before the current one counts as done.
   */
  done?: readonly boolean[];
}) {
  const list = (
    <ol
      aria-label={onStep ? undefined : label}
      className={cx('grid gap-1.5', !onStep && className)}
      style={{ gridTemplateColumns: columns ?? `repeat(${steps.length}, minmax(0, 1fr))` }}
    >
      {steps.map((s, i) => {
        const state = i === current ? 'current' : (done ? done[i] : i < current) ? 'done' : 'todo';
        const badge = badges?.[i];
        const body = (
          <>
            <span
              aria-hidden
              className={cx(
                'block h-[7px] rounded-full',
                state === 'todo' ? 'bg-track shadow-[inset_0_0_0_2px_var(--track-edge)]' : 'bg-ink',
                state === 'current' && 'outline-2 outline-offset-2 outline-ink outline-solid',
              )}
            />
            {badge ? (
              // Sits over the end of the bar, so the step's name keeps its room.
              <span
                aria-hidden
                className="absolute -top-1 right-0 inline-flex h-6 items-center gap-0.5 rounded-full border-[1.5px] border-solid border-warn bg-warn-fill px-1.5 font-num text-[15px] leading-none font-extrabold text-warn"
              >
                <Icon icon={TriangleAlert} size="xs" />
                {badge.count}
              </span>
            ) : null}
            <span className={cx('mt-2 block min-w-0 truncate text-[15px] leading-tight', state === 'todo' ? 'font-semibold text-ink-3' : 'font-extrabold text-ink')}>
              <span className="font-num [font-stretch:80%]">{i + 1}</span> {s}
              <span className="sr-only">
                {badge ? ` (${badge.label})` : ''}
                {state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}
              </span>
            </span>
          </>
        );
        return (
          <li key={s} aria-current={!onStep && state === 'current' ? 'step' : undefined} className={cx('min-w-0', !onStep && 'relative')}>
            {onStep ? (
              <button
                type="button"
                onClick={() => onStep(i)}
                aria-current={state === 'current' ? 'step' : undefined}
                className="relative block min-h-12 w-full rounded-control px-0.5 pt-1.5 pb-1 text-left focus-visible:outline-offset-0"
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ol>
  );
  return onStep ? (
    <nav aria-label={label} className={className}>
      {list}
    </nav>
  ) : (
    list
  );
}
