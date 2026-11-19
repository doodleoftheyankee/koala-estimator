'use client';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { priceEstimate, type PriceApproval, type PricingBundle } from '@/lib/pricing';
import type { DeviationFlag } from '@/lib/learning/types';
import { db, getCachedBundle, type CachedProfile, type LocalEstimate } from '@/lib/offline/db';
import { isReachable, onReachChange, refreshBundle, syncEstimate } from '@/lib/offline/sync';
import { draftSchema, priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { ackState, parseFlagList, unacknowledgedFlags } from '@/lib/field/flags';
import { recommendedTier } from '@/lib/field/recommended';
import { sendChecks, type SendCheck, type SendCheckApproval } from '@/lib/field/sendChecks';
import type { FixTarget } from '@/lib/field/fix';
import { approvalsFromRows } from '@/lib/quotes/approvals';
import { formatDateTime, usd } from '@/lib/format';
import { Alert, Button, Card, Field, Input } from '@/components/ui';
import { Check, Circle, Icon, Star } from '@/components/daymark';
import type { PricingResult } from './EstimateEditor';

type SendResult =
  | { kind: 'idle' }
  | { kind: 'busy'; msg: string }
  | { kind: 'done'; url: string; emailed: boolean; version: number }
  | { kind: 'error'; msg: string; reasons?: string[] }
  /** The server found changes from the model without a note (409 unacknowledged_flags). */
  | { kind: 'flags'; msg: string; flags: Array<{ key: string; message: string }> };

/** How often the phone looks again while a price waits for the owner or the office. */
const APPROVAL_POLL_MS = 20_000;

/** This estimate's price approvals from the office copy, kept fresh while one is waiting. */
function useApprovals(estimateId: string, online: boolean, synced: boolean) {
  const [approvals, setApprovals] = useState<PriceApproval[]>([]);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/approvals?estimateId=${encodeURIComponent(estimateId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { approvals?: unknown };
      setApprovals(approvalsFromRows((body.approvals as unknown[] | undefined)?.map(toRow) ?? []));
    } catch {
      // Offline or Koala unreachable: keep what we had; sending needs a connection anyway.
    }
  }, [estimateId]);
  useEffect(() => {
    if (!online || !synced) return;
    const first = setTimeout(() => void load(), 0);
    return () => clearTimeout(first);
  }, [online, synced, load]);
  const waiting = approvals.some((a) => a.status === 'pending');
  useEffect(() => {
    if (!online || !waiting) return;
    const t = setInterval(() => void load(), APPROVAL_POLL_MS);
    return () => clearInterval(t);
  }, [online, waiting, load]);
  return { approvals, reload: load };
}

/** The API answers with PriceApproval objects; read them back through the row parser. */
function toRow(a: unknown): unknown {
  const x = a as Partial<PriceApproval>;
  return {
    id: x.id,
    estimate_id: x.estimateId,
    tier: x.tier,
    price: x.price,
    model_price: x.modelPrice,
    below_floor: x.belowFloor,
    loaded_cost: x.loadedCost ?? null,
    status: x.status,
    decided_role: x.decidedRole ?? null,
    note: x.note ?? null,
    decision_note: x.decisionNote ?? null,
    requested_at: x.requestedAt,
    requested_by: x.requestedBy,
    decided_at: x.decidedAt ?? null,
  };
}

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
  onFix,
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
  /** Opens the step (or page) a checklist item's Fix button points at. */
  onFix: (target: FixTarget) => void;
}) {
  const [result, setResult] = useState<SendResult>({ kind: 'idle' });
  // Signal is not enough: while Koala does not answer, Send and Request approval wait (review B flow-B2).
  const reachable = useSyncExternalStore(onReachChange, isReachable, () => true);
  const options = priced?.ok?.options ?? [];
  const pendingFlags = unacknowledgedFlags(flags, draft.deviationAcks);
  const { approvals, reload } = useApprovals(record.id, online, draft.rowVersion !== null);
  // The option the quote will recommend (OD1): the pick, the next one shown if it is hidden, else Better.
  const recommended = recommendedTier(options, draft.selectedTier)?.tier ?? null;

  const checks = sendChecks({
    draft,
    options,
    role: profile.role,
    settings: bundle?.snapshot.settings ?? null,
    approvals,
    pendingFlags: pendingFlags.length,
    online,
    reachable,
  });
  const canSend = !locked && checks.every((c) => c.ok) && record.syncState !== 'conflict';

  /** Saves and syncs the estimate so the office copy is the one on this phone. */
  async function syncFirst(): Promise<boolean> {
    await flush();
    const synced = await syncEstimate(record.id);
    if (synced?.syncState !== 'synced') {
      setResult({ kind: 'error', msg: synced?.lastError ?? 'Could not sync this estimate. Try again.' });
      return false;
    }
    return true;
  }

  async function send() {
    setResult({ kind: 'busy', msg: 'Saving and syncing…' });
    if (!(await syncFirst())) return;
    const synced = await db().estimates.get(record.id);
    if (!synced) return;
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
          void reload();
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

  async function requestApproval(a: SendCheckApproval, note: string): Promise<string | null> {
    setResult({ kind: 'busy', msg: 'Saving and asking for approval…' });
    if (!(await syncFirst())) return 'Could not sync this estimate.';
    try {
      const res = await fetch('/api/approvals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ estimateId: record.id, tier: a.tier, price: a.price, note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      await reload();
      if (!res.ok) {
        setResult({ kind: 'error', msg: body.message ?? 'Asking for approval failed.' });
        return body.message ?? 'failed';
      }
      setResult({ kind: 'idle' });
      return null;
    } catch {
      setResult({ kind: 'error', msg: 'Lost connection while asking. Check signal and try again.' });
      return 'offline';
    }
  }

  const failing = checks.filter((c) => !c.ok).length;

  return (
    <>
      <Card>
        <h2 className="mb-1 font-semibold">Ready to send?</h2>
        <p className="mb-3 text-sm text-slate-600">
          {failing === 0 ? 'Everything the quote needs is here.' : failing === 1 ? 'One thing to do before this quote can go out.' : `${failing} things to do before this quote can go out.`}
        </p>
        <ul className="space-y-3" aria-label="Send checklist">
          {checks.map((c) => (
            <CheckItem
              key={c.id}
              check={c}
              onFix={onFix}
              onRequest={requestApproval}
              onCheckAgain={reload}
              disabled={locked || result.kind === 'busy'}
              online={online && reachable}
              flagMessages={c.id === 'flags' && !c.ok ? pendingFlags.map((f) => `${f.message}${ackState(f, draft.deviationAcks).status === 'stale' ? ' Check your earlier note, then confirm or edit it.' : ''}`) : []}
            />
          ))}
        </ul>
      </Card>

      {options.length ? (
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-slate-600">The customer will see</h3>
          <ul className="space-y-1">
            {options.map((o) => (
              <li key={o.tier} className="flex justify-between text-sm">
                <span>
                  {o.label}
                  {recommended === o.tier ? <Icon icon={Star} size="xs" label="Recommended" className="ml-1 inline-block fill-current align-[-2px]" /> : null}
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
          <Button size="sm" variant="secondary" className="mt-2" onClick={() => onFix({ step: 'options' })}>
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
            Last sent: v{draft.lastQuote.version} on {formatDateTime(draft.lastQuote.sentAt)}
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

/** One line of the checklist: done or to do, with its Fix button or its approval request. */
function CheckItem({
  check,
  onFix,
  onRequest,
  onCheckAgain,
  disabled,
  online,
  flagMessages,
}: {
  check: SendCheck;
  onFix: (t: FixTarget) => void;
  onRequest: (a: SendCheckApproval, note: string) => Promise<string | null>;
  onCheckAgain: () => Promise<void>;
  disabled: boolean;
  online: boolean;
  flagMessages: string[];
}) {
  return (
    <li className="flex gap-2 text-sm" data-check={check.id} data-ok={check.ok ? 'yes' : 'no'}>
      <span aria-hidden className={check.ok ? 'text-emerald-600' : 'text-amber-600'}>
        <Icon icon={check.ok ? Check : Circle} size="s" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={check.ok ? 'text-slate-700' : 'font-medium text-amber-900'}>
          <span className="sr-only">{check.ok ? 'Done: ' : 'To do: '}</span>
          {check.label}
        </p>
        {flagMessages.length ? (
          <ul className="mt-1 list-disc pl-4 text-slate-700">
            {flagMessages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : null}
        {!check.ok && (check.fix || check.approval) ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {check.approval ? <ApprovalRequest approval={check.approval} onRequest={onRequest} onCheckAgain={onCheckAgain} disabled={disabled || !online} /> : null}
            {check.fix ? (
              <Button size="sm" variant="secondary" onClick={() => onFix(check.fix!.target)}>
                {check.fix.label}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

/** Request approval for a price beyond the estimator's range; then waiting, or the decision. */
function ApprovalRequest({
  approval,
  onRequest,
  onCheckAgain,
  disabled,
}: {
  approval: SendCheckApproval;
  onRequest: (a: SendCheckApproval, note: string) => Promise<string | null>;
  onCheckAgain: () => Promise<void>;
  disabled: boolean;
}) {
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const who = approval.approver === 'owner' ? 'the owner' : 'the owner or the office';
  if (approval.status === 'pending') {
    return (
      <div className="w-full space-y-2">
        <p className="text-slate-700" role="status">
          Waiting for {who} to approve {usd(approval.price)}.
        </p>
        <Button size="sm" variant="secondary" disabled={disabled} onClick={() => void onCheckAgain()}>
          Check again
        </Button>
      </div>
    );
  }
  return (
    <div className="w-full space-y-2">
      {approval.status === 'declined' ? (
        <p className="text-red-800">
          {usd(approval.price)} was declined{approval.decisionNote ? `: ${approval.decisionNote}` : '.'}
        </p>
      ) : null}
      <Field label={`Why this price? (for ${who})`}>
        <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </Field>
      <Button
        size="sm"
        disabled={disabled || asking}
        onClick={async () => {
          setAsking(true);
          const failed = await onRequest(approval, note);
          setAsking(false);
          if (!failed) setNote('');
        }}
      >
        {approval.status === 'declined' ? 'Ask again' : 'Request approval'}
      </Button>
    </div>
  );
}
