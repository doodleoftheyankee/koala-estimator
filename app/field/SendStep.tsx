'use client';
import { useState } from 'react';
import { canSendQuote, priceEstimate, type PricingBundle } from '@/lib/pricing';
import type { DeviationFlag } from '@/lib/learning/types';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { refreshBundle, syncEstimate } from '@/lib/offline/sync';
import { syncBlocker } from '@/lib/offline/syncCore';
import { draftSchema, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { parseFlagList, unacknowledgedFlags } from '@/lib/field/flags';
import { usd } from '@/lib/format';
import { Alert, Button, Card } from '@/components/ui';
import type { PricingResult } from './EstimateEditor';

type SendResult =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string }
  | { kind: 'done'; url: string; emailed: boolean; version: number }
  | { kind: 'error'; msg: string; reasons?: string[] }
  /** The server found changes from the model without a note (409 unacknowledged_flags). */
  | { kind: 'flags'; msg: string; flags: Array<{ key: string; message: string }> };

export function SendStep({
  draft,
  record,
  priced,
  flags,
  bundle,
  profile,
  online,
  flush,
  locked,
  onReviewOptions,
}: {
  draft: EstimateDraft;
  record: LocalEstimate;
  priced: PricingResult;
  /** Deviation flags for the draft as priced on this phone. */
  flags: DeviationFlag[];
  bundle: PricingBundle | null;
  profile: CachedProfile;
  online: boolean;
  flush: () => Promise<void>;
  locked: boolean;
  /** Takes the estimator to the Options tab, where flags are explained. */
  onReviewOptions: () => void;
}) {
  const [result, setResult] = useState<SendResult>({ kind: 'idle' });
  const options = priced?.ok?.options ?? [];
  const blocker = syncBlocker(draft);
  const policy = bundle && options.length ? canSendQuote(profile.role, options, bundle.snapshot.settings) : null;
  const pendingFlags = unacknowledgedFlags(flags, draft.deviationAcks);

  const checks: Array<{ ok: boolean; label: string }> = [
    { ok: !blocker, label: blocker ?? 'Customer, address and areas complete' },
    { ok: !!draft.customer.email, label: draft.customer.email ? `Email: ${draft.customer.email}` : 'Customer email needed to send' },
    { ok: options.length > 0, label: options.length ? `${options.length} option(s) priced` : 'No priced options yet' },
    { ok: !!policy?.ok, label: policy?.ok ? 'Prices within your approval limits' : 'Price changes need approval (see below)' },
    {
      ok: pendingFlags.length === 0,
      label: pendingFlags.length
        ? `Every change from the model is explained (${pendingFlags.length} still ${pendingFlags.length === 1 ? 'needs' : 'need'} a note)`
        : 'Every change from the model is explained',
    },
    { ok: online, label: online ? 'Online' : 'Offline. Sending needs a connection; your work is saved.' },
  ];
  const canSend = !locked && checks.every((c) => c.ok) && record.syncState !== 'conflict';

  async function send() {
    setResult({ kind: 'busy', msg: 'Saving and syncing…' });
    await flush();
    const synced = await syncEstimate(record.id);
    if (synced?.syncState !== 'synced') {
      setResult({ kind: 'error', msg: synced?.lastError ?? 'Could not sync this estimate. Try again.' });
      return;
    }
    // Price with the freshest bundle so our expected prices match the server's.
    const fresh = (await refreshBundle()) ?? (await getCachedBundle());
    if (!fresh) {
      setResult({ kind: 'error', msg: 'Pricing is not available. Try again with signal.' });
      return;
    }
    const current = synced.draft;
    const expected = priceEstimate({ ...toEstimateInput(current), areas: priceableAreas(current) }, fresh.snapshot, fresh.coefficientSet);
    const expectedPrices = Object.fromEntries(expected.options.map((o) => [o.tier, o.price]));

    setResult({ kind: 'busy', msg: 'Creating the quote PDF and emailing it…' });
    try {
      const res = await fetch('/api/quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: record.id, expectedPrices }),
      });
      const body = (await res.json()) as {
        error?: string;
        message?: string;
        reasons?: string[];
        flags?: unknown;
        url?: string;
        emailed?: boolean;
        version?: number;
        rowVersion?: number;
        clientDoc?: unknown;
      };
      if (!res.ok) {
        if (body.error === 'unacknowledged_flags') {
          setResult({
            kind: 'flags',
            msg: body.message ?? 'Explain each change from the model before sending.',
            flags: parseFlagList(body.flags),
          });
        } else if (body.error === 'pricing_changed') {
          setResult({ kind: 'error', msg: 'Prices changed since this phone last downloaded pricing. Review the Options tab, then send again.' });
        } else if (body.error === 'policy') {
          setResult({ kind: 'error', msg: 'This quote needs approval before it can be sent.', reasons: body.reasons });
        } else setResult({ kind: 'error', msg: body.message ?? body.error ?? 'Sending failed.' });
        return;
      }
      const doc = draftSchema.safeParse(body.clientDoc);
      await db().transaction('rw', db().estimates, async () => {
        const cur = await db().estimates.get(record.id);
        if (!cur) return;
        const nextDraft = doc.success ? { ...doc.data, rowVersion: body.rowVersion ?? null } : { ...cur.draft, status: 'sent' as const, rowVersion: body.rowVersion ?? null };
        await db().estimates.put({ ...cur, draft: nextDraft, syncState: 'synced', mutationId: crypto.randomUUID(), lastError: null, syncedAt: new Date().toISOString() });
      });
      setResult({ kind: 'done', url: body.url!, emailed: !!body.emailed, version: body.version ?? 1 });
    } catch {
      setResult({ kind: 'error', msg: 'Lost connection while sending. Check signal and try again.' });
    }
  }

  return (
    <>
      <Card>
        <h2 className="mb-3 font-semibold">Ready to send?</h2>
        <ul className="space-y-2">
          {checks.map((c, i) => (
            <li key={i} className="flex gap-2 text-sm">
              <span aria-hidden className={c.ok ? 'text-emerald-600' : 'text-amber-600'}>
                {c.ok ? '✓' : '•'}
              </span>
              <span className={c.ok ? 'text-slate-700' : 'text-amber-900'}>{c.label}</span>
            </li>
          ))}
        </ul>
        {policy && !policy.ok ? (
          <div className="mt-3">
            <Alert tone="amber">
              <ul className="list-disc pl-4">
                {policy.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Alert>
          </div>
        ) : null}
        {pendingFlags.length ? (
          <div className="mt-3">
            <Alert tone="amber">
              <p className="font-semibold">These changes from the model need a short note:</p>
              <ul className="mt-1 list-disc pl-4">
                {pendingFlags.map((f) => (
                  <li key={f.key}>{f.message}</li>
                ))}
              </ul>
              <Button size="sm" variant="secondary" className="mt-2" onClick={onReviewOptions}>
                Explain on the Options tab
              </Button>
            </Alert>
          </div>
        ) : null}
      </Card>

      {options.length ? (
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-600">The customer will see</h3>
          <ul className="space-y-1">
            {options.map((o) => (
              <li key={o.tier} className="flex justify-between text-sm">
                <span>
                  {o.label}
                  {draft.selectedTier === o.tier ? ' ★' : ''}
                </span>
                <span className="font-semibold">{usd(o.price)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {result.kind === 'busy' ? <Alert tone="blue">{result.msg}</Alert> : null}
      {result.kind === 'error' ? (
        <Alert tone="red">
          <p>{result.msg}</p>
          {result.reasons?.length ? (
            <ul className="mt-1 list-disc pl-4">
              {result.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
        </Alert>
      ) : null}
      {result.kind === 'flags' ? (
        <Alert tone="amber">
          <p className="font-semibold">Not sent. {result.msg}</p>
          {result.flags.length ? (
            <ul className="mt-1 list-disc pl-4">
              {result.flags.map((f) => (
                <li key={f.key}>{f.message}</li>
              ))}
            </ul>
          ) : null}
          <Button size="sm" variant="secondary" className="mt-2" onClick={onReviewOptions}>
            Go to the Options tab
          </Button>
        </Alert>
      ) : null}
      {result.kind === 'done' ? (
        <Alert tone="green">
          <p className="font-semibold">Quote v{result.version} sent.</p>
          <p>{result.emailed ? `Emailed to ${draft.customer.email}.` : 'Email is not set up yet; share the link below with the customer.'}</p>
          <a className="mt-1 block break-all font-medium underline" href={result.url} target="_blank" rel="noreferrer">
            {result.url}
          </a>
        </Alert>
      ) : null}

      {!locked ? (
        <Button size="lg" className="w-full" disabled={!canSend || result.kind === 'busy'} onClick={send}>
          {draft.lastQuote ? `Send updated quote (v${draft.lastQuote.version + 1})` : 'Send quote to customer'}
        </Button>
      ) : null}

      {draft.lastQuote ? (
        <Card>
          <p className="text-sm text-slate-600">
            Last sent: v{draft.lastQuote.version} on {new Date(draft.lastQuote.sentAt).toLocaleString()}
          </p>
          {online ? (
            <a className="mt-1 inline-block text-sm font-semibold text-brand-800 underline" href={`/api/quotes/${draft.lastQuote.quoteId}/pdf${locked ? '?signed=1' : ''}`} target="_blank" rel="noreferrer">
              Open {locked ? 'signed ' : ''}PDF
            </a>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
