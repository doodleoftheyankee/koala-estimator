'use client';
// Approve or Decline one waiting price (PATCH /api/approvals/[id]), with an optional note for the
// estimator; the list refreshes after the decision.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner, Button, Field, Input } from '@/components/daymark';

export function DecideButtons({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: 'approved' | 'declined') {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) setError(body.message ?? 'That did not work. Try again.');
      router.refresh();
    } catch {
      setError('Could not reach Koala. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <Field label="Note for the estimator (optional)">
        <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={() => decide('approved')} aria-label={`Approve ${label}`}>
          Approve
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide('declined')} aria-label={`Decline ${label}`}>
          Decline
        </Button>
      </div>
      {error ? (
        <Banner tone="bad" title="Not saved">
          {error}
        </Banner>
      ) : null}
    </div>
  );
}
