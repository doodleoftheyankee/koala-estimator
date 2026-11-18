// The thumb dock: a fixed bottom bar with a 3px rule on top, safe-area padding, an optional
// one-line "what this does" note, and the 64px action(s). Put the screen's main action here and
// repeat the chosen value in it ("Use 1,970 sq ft").
//
//   <Dock note="Fills the Attic floor and notes the source">
//     <Button variant="primary" size="lg" block>Use {sqft(area)}</Button>
//   </Dock>
//   <DockSpacer />   at the end of the page content, so the last fields are never hidden
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Check, Icon } from './icons';

export function Dock({
  children,
  note,
  className,
  label = 'Actions',
  inline = false,
}: {
  children: ReactNode;
  note?: ReactNode;
  className?: string;
  label?: string;
  /** Render in the flow instead of fixed to the bottom (previews such as the /design page). */
  inline?: boolean;
}) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cx(
        'border-t-[length:var(--bw-x)] border-solid border-rule bg-surface px-4 pt-3',
        inline ? 'pb-3' : 'fixed inset-x-0 bottom-0 z-30 pb-[max(12px,var(--safe-bottom))]',
        className,
      )}
    >
      <div className="mx-auto max-w-2xl">
        {note ? (
          <p className="mb-2.5 flex items-center gap-2 text-[15.5px] font-semibold text-ink-2">
            <span className="text-ok">
              <Icon icon={Check} size="s" />
            </span>
            {note}
          </p>
        ) : null}
        <div className="flex items-stretch gap-3 [&>*]:min-w-0 [&>*]:flex-1">{children}</div>
      </div>
    </div>
  );
}

/** Reserves room under the page content for a Dock (with or without a note). */
export function DockSpacer({ withNote = false }: { withNote?: boolean }) {
  return <div aria-hidden className={withNote ? 'h-[calc(128px+var(--safe-bottom))]' : 'h-[calc(96px+var(--safe-bottom))]'} />;
}
