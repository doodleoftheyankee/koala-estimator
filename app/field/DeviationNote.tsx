'use client';
import type { DeviationFlag } from '@/lib/learning/types';
import { ACK_MAX_LENGTH, type AckState } from '@/lib/field/flags';
import { formatPctDiff } from '@/lib/field/lineOverrides';
import { Alert, Button, Field, Textarea } from '@/components/ui';

/**
 * One deviation flag (PLAN.md §6.5) with the estimator's note: amber until explained, green
 * after. The note is saved with the draft (offline), together with the deviation it explains, and
 * required before the quote can be sent. A note written for a different deviation (the line or
 * price changed since) stays in the box but no longer counts until the estimator confirms or
 * edits it; either one saves it for the deviation as it is now.
 */
export function DeviationNote({ flag, ack, onNote }: { flag: DeviationFlag; ack: AckState; onNote: (note: string) => void }) {
  const explained = ack.status === 'explained';
  const stale = ack.status === 'stale';
  return (
    <Alert tone={explained ? 'green' : 'amber'}>
      <p className="font-semibold">
        <span aria-hidden>{explained ? '✓ ' : '! '}</span>
        <span className="sr-only">{explained ? 'Explained: ' : stale ? 'Check your note: ' : 'Needs a note: '}</span>
        {flag.message}
      </p>
      {flag.reasons.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {flag.reasons.map((r, i) => (
            <li key={i}>{r.text}</li>
          ))}
        </ul>
      ) : null}
      {stale ? (
        <p className="mt-2 text-xs">
          {ack.ackedPctDiff !== null
            ? `Your note was written when this change was ${formatPctDiff(ack.ackedPctDiff)}; it is now ${formatPctDiff(flag.pctDiff)}.`
            : 'Your note was saved by an earlier version of the app.'}{' '}
          Confirm it still explains this change, or edit it.
        </p>
      ) : null}
      <Field
        className="mt-2"
        label={explained ? 'Your explanation' : stale ? 'Check your earlier note (needed to send)' : 'Explain this change (needed to send)'}
      >
        <Textarea
          rows={2}
          maxLength={ACK_MAX_LENGTH}
          value={ack.note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="What did you see on site that the model doesn't know?"
        />
      </Field>
      {stale ? (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => onNote(ack.note)}>
          Note still applies
        </Button>
      ) : null}
    </Alert>
  );
}
