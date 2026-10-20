'use client';
import type { DeviationFlag } from '@/lib/learning/types';
import { ACK_MAX_LENGTH } from '@/lib/field/flags';
import { Alert, Field, Textarea } from '@/components/ui';

/**
 * One deviation flag (PLAN.md §6.5) with the estimator's note: amber until explained, green
 * after. The note is saved with the draft (offline) and required before the quote can be sent.
 */
export function DeviationNote({ flag, note, onNote }: { flag: DeviationFlag; note: string; onNote: (note: string) => void }) {
  const explained = note.trim().length > 0;
  return (
    <Alert tone={explained ? 'green' : 'amber'}>
      <p className="font-semibold">
        <span aria-hidden>{explained ? '✓ ' : '! '}</span>
        <span className="sr-only">{explained ? 'Explained: ' : 'Needs a note: '}</span>
        {flag.message}
      </p>
      {flag.reasons.length ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
          {flag.reasons.map((r, i) => (
            <li key={i}>{r.text}</li>
          ))}
        </ul>
      ) : null}
      <Field className="mt-2" label={explained ? 'Your explanation' : 'Explain this change (needed to send)'}>
        <Textarea
          rows={2}
          maxLength={ACK_MAX_LENGTH}
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="What did you see on site that the model doesn't know?"
        />
      </Field>
    </Alert>
  );
}
