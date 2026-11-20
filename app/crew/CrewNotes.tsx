// Notes for the crew, as the crew reads them (never a price: crew_job_view takes prices out): the
// estimator's, written on the estimate, and the office's, added after booking. Used by the load
// list (per job) and the crew's job page (at the top).
import type { CrewNotes } from '@/lib/jobs/loadList';
import { cx, Icon, MessageSquareText, SignLabel } from '@/components/daymark';

export const hasNotes = (n: CrewNotes) => Boolean(n.estimator || n.office);

export function CrewNotesBlock({ notes, className }: { notes: CrewNotes; className?: string }) {
  if (!hasNotes(notes)) return null;
  return (
    <div className={cx('space-y-2', className)}>
      {notes.estimator ? <Note who="From the estimator" text={notes.estimator} /> : null}
      {notes.office ? <Note who="From the office" text={notes.office} /> : null}
    </div>
  );
}

function Note({ who, text }: { who: string; text: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-control bg-sunken px-3 py-2.5" role="note" aria-label={who}>
      <Icon icon={MessageSquareText} size="s" className="mt-0.5 text-ink" />
      <div className="min-w-0">
        <SignLabel tone="ink-2">{who}</SignLabel>
        <p className="mt-1 text-[16.5px] leading-snug font-semibold whitespace-pre-line text-ink [overflow-wrap:anywhere]">{text}</p>
      </div>
    </div>
  );
}
