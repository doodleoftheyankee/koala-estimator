// The thumb dock: a bottom bar with a 3px rule on top, safe-area padding, an optional one-line
// "what this does" note, and the 64px action(s). Put the screen's main action here and repeat the
// chosen value in it ("Use 1,970 sq ft"). Inside the app shell the fixed dock sits above the phone
// tab bar and beside the desktop sidebar (--shell-bottom, --shell-left in app/globals.css).
//
//   <Dock note="Fills the Attic floor and notes the source">
//     <Button variant="primary" size="lg" block>Use {sqft(area)}</Button>
//   </Dock>
//   <Dock blocked="Check the house first: tap Right house.">…</Dock>   why the action can't be used yet
//   <Dock position="sticky">…</Dock>     at the bottom of a full-screen sheet's own scroll
//   <DockSpacer />   at the end of the page content, so the last fields are never hidden
//
// Two buttons side by side get a tighter "pair" density by themselves, so each label stays on one
// line on a 390px phone.
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Check, Icon, TriangleAlert } from './icons';

export type DockPosition = 'fixed' | 'sticky' | 'inline';

const POSITION: Record<DockPosition, string> = {
  fixed: 'fixed right-0 bottom-[var(--shell-bottom)] left-[var(--shell-left)] z-30 pb-[max(12px,var(--shell-safe))]',
  sticky: 'sticky bottom-0 z-30 pb-[max(12px,env(safe-area-inset-bottom))]',
  inline: 'pb-3',
};

/** Two or more actions in a row: less padding, a smaller label, no wrapping. */
const PAIR =
  'has-[>:nth-child(2)]:gap-2 has-[>:nth-child(2)]:[&>*]:gap-2 has-[>:nth-child(2)]:[&>*]:px-3 has-[>:nth-child(2)]:[&>*]:text-[18px] has-[>:nth-child(2)]:[&>*]:whitespace-nowrap';

export function Dock({
  children,
  note,
  blocked,
  className,
  label = 'Actions',
  position,
  inline = false,
}: {
  children: ReactNode;
  /** What the action does, with a green tick. */
  note?: ReactNode;
  /** Why the action can't be used yet, with a warning sign. Shown instead of the note. */
  blocked?: ReactNode;
  className?: string;
  label?: string;
  /** fixed (default) above the tab bar; sticky inside a full-screen sheet; inline in the flow. */
  position?: DockPosition;
  /** Same as position="inline" (previews such as the /design page). */
  inline?: boolean;
}) {
  const at: DockPosition = position ?? (inline ? 'inline' : 'fixed');
  return (
    <div role="region" aria-label={label} className={cx('border-t-[length:var(--bw-x)] border-solid border-rule bg-surface px-4 pt-3', POSITION[at], className)}>
      <div className="mx-auto max-w-2xl">
        {blocked ? (
          <p className="mb-2.5 flex items-start gap-2 text-[15.5px] leading-snug font-bold text-warn">
            <Icon icon={TriangleAlert} size="s" className="mt-0.5" />
            <span>{blocked}</span>
          </p>
        ) : note ? (
          <p className="mb-2.5 flex items-start gap-2 text-[15.5px] leading-snug font-semibold text-ink-2">
            <span className="mt-0.5 text-ok">
              <Icon icon={Check} size="s" />
            </span>
            <span>{note}</span>
          </p>
        ) : null}
        <div className={cx('flex items-stretch gap-3 [&>*]:min-w-0 [&>*]:flex-1', PAIR)}>{children}</div>
      </div>
    </div>
  );
}

/** Reserves room under the page content for a fixed Dock (with or without a note). */
export function DockSpacer({ withNote = false }: { withNote?: boolean }) {
  return <div aria-hidden className={withNote ? 'h-[calc(128px+var(--shell-safe))]' : 'h-[calc(96px+var(--shell-safe))]'} />;
}
