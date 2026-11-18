// The product mark and the step track.
//
//   <Monogram />                     the KE tile: condensed Archivo on ink, a hi-vis daymark corner
//   <StepTrack steps={['Customer', 'Areas', 'Options', 'Send']} current={1} />
//
// The mark belongs to the product, not to a franchise. A franchise's own colour appears only in
// its logo tile on the quote and in its PDF letterhead.
import { cx } from './cx';

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

/** The step track: done steps are ink, the current step is ink with a ring, upcoming steps use the track. */
export function StepTrack({ steps, current, className, label = 'Steps' }: { steps: readonly string[]; current: number; className?: string; label?: string }) {
  return (
    <ol aria-label={label} className={cx('grid gap-1.5', className)} style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
      {steps.map((s, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li key={s} aria-current={state === 'current' ? 'step' : undefined} className="min-w-0">
            <span
              aria-hidden
              className={cx(
                'block h-[7px] rounded-full',
                state === 'todo' ? 'bg-track shadow-[inset_0_0_0_2px_var(--track-edge)]' : 'bg-ink',
                state === 'current' && 'outline-2 outline-offset-2 outline-ink outline-solid',
              )}
            />
            <span className={cx('mt-2 block truncate text-[15px] leading-tight', state === 'todo' ? 'font-semibold text-ink-3' : 'font-extrabold text-ink')}>
              {i + 1} {s}
              <span className="sr-only">{state === 'done' ? ' (done)' : state === 'current' ? ' (current step)' : ''}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
