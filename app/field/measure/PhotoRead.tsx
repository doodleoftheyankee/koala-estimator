'use client';
// "Read these photos": AI looks at the area's photos and suggests what to fill in (existing
// insulation, depth, R-value, access, removal, size, cutouts) and flags hazards. Nothing changes
// until the estimator taps Apply; every suggestion shows what it's based on and how sure it is.
import { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '@/lib/offline/db';
import { deletedOnThisPhone, type LocalPhoto } from '@/lib/offline/photos';
import { onReadFinished, photoReadAvailable, runningRead, sendReadFeedback, startPhotoRead, takeFinishedRead, type ReadOutcome } from '@/lib/offline/photoRead';
import { measuredSqft } from '@/lib/measure/measure';
import { HAZARD_LABELS, suggestionsFor, type Confidence, type ReadContext, type StoredPhotoRead, type Suggestion } from '@/lib/ai/photoRead';
import type { RemotePhoto } from '@/lib/photos/rules';
import type { AreaDraft } from '@/lib/sync/draft';
import type { Measurement } from '@/lib/measure/measure';
import { Alert, Badge, Button } from '@/components/ui';
import { useLive, useOnline } from '../hooks';

const CONFIDENCE_TONE: Record<Confidence, 'green' | 'amber' | 'slate'> = { high: 'green', medium: 'amber', low: 'slate' };
const SPACE_WORDS: Record<string, string> = {
  attic_floor: 'an attic floor',
  attic_roofline: 'an attic roofline',
  cathedral_ceiling: 'a cathedral ceiling',
  crawlspace: 'a crawlspace',
  basement_rim_joist: 'a basement rim joist',
  open_wall_cavity: 'open wall cavities',
  garage: 'a garage',
  other: 'something else',
  unclear: 'nothing clear enough to read',
};

export function PhotoRead({
  context,
  area,
  measurement,
  stored,
  remote,
  onRead,
  onApply,
  onDecide,
}: {
  context: Omit<ReadContext, 'areaId' | 'areaName' | 'jobType' | 'sqft' | 'measured' | 'currentR' | 'existingMaterial'>;
  area: AreaDraft;
  measurement: Measurement | undefined;
  stored: StoredPhotoRead | undefined;
  remote: RemotePhoto[];
  onRead: (r: StoredPhotoRead) => void;
  onApply: (s: Suggestion) => void;
  onDecide: (key: string, decision: 'applied' | 'dismissed') => void;
}) {
  const online = useOnline();
  const local = useLive(() => db().photos.where('areaId').equals(area.id).toArray(), [area.id], [] as LocalPhoto[]);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(() => Boolean(runningRead(area.id)));
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const onReadRef = useRef(onRead);
  useEffect(() => {
    onReadRef.current = onRead;
  }, [onRead]);

  // Ask the server whether AI reading is on only when it could be used (signal and photos).
  const hasPhotos = local.some((p) => p.state !== 'deleting') || remote.some((r) => r.areaId === area.id);
  useEffect(() => {
    if (!online || !hasPhotos) return;
    let live = true;
    void photoReadAvailable().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, [online, hasPhotos]);

  /** A finished read (this visit or while the card was closed): store it, or show why it failed. */
  const settle = useCallback((outcome: ReadOutcome | undefined) => {
    if (!outcome) return;
    setBusy(false);
    if (outcome.ok) {
      const r = outcome.response;
      onReadRef.current({ read: r.read, analysisId: r.analysisId, model: r.model, createdAt: r.createdAt, photoIds: r.photoIds, decisions: {} });
      setError(null);
      return;
    }
    const e = outcome.error;
    if (e.code === 'aborted') return;
    if (e.code === 'not_configured') setAvailable(false);
    setError(e.message);
  }, []);

  // Reads keep running when the card closes; pick up one that finished meanwhile, and listen
  // for the one running now. Leaving the card never cancels a read (only Stop does).
  useEffect(() => {
    const waiting = takeFinishedRead(area.id);
    if (waiting) queueMicrotask(() => settle(waiting));
    return onReadFinished((id) => id === area.id && settle(takeFinishedRead(area.id)));
  }, [area.id, settle]);

  useEffect(() => {
    if (!busy) return;
    const tick = () => setElapsed(Math.round((Date.now() - (runningRead(area.id)?.startedAt ?? Date.now())) / 1000));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [busy, area.id]);

  const phonePhotos = local.filter((p) => p.state !== 'deleting').sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const known = new Set(local.map((p) => p.id));
  const serverPhotos = remote.filter((r) => r.areaId === area.id && !known.has(r.id) && !deletedOnThisPhone(r.id));
  const photoCount = phonePhotos.length + serverPhotos.length;
  const currentIds = [...phonePhotos.map((p) => p.id), ...serverPhotos.map((r) => r.id)];
  const newSinceRead = stored ? currentIds.some((id) => !stored.photoIds.includes(id)) : false;

  const read = () => {
    setError(null);
    setBusy(true);
    setElapsed(0);
    const m = measurement ? measuredSqft(measurement) : null;
    startPhotoRead(
      {
        ...context,
        areaId: area.id,
        areaName: area.name,
        jobType: area.jobType,
        sqft: area.sqft || null,
        measured: m !== null && m === Math.round(area.sqft),
        currentR: area.currentR || null,
        existingMaterial: area.existingMaterial,
      },
      phonePhotos,
      serverPhotos,
    );
  };

  const all = stored ? suggestionsFor(stored.read, area, measurement) : [];
  const suggestions = all.filter((s) => !stored?.decisions[s.key]);
  const inBatch = suggestions.filter((s) => !s.onlyOnItsOwn);
  const decided = stored ? Object.values(stored.decisions) : [];
  const apply = (list: Suggestion[]) => {
    for (const s of list) {
      onApply(s);
      onDecide(s.key, 'applied');
    }
    sendReadFeedback(stored?.analysisId ?? null, list.map((s) => ({ field: s.key, aiValue: s.to, confirmedValue: s.to, accepted: true })));
  };
  const dismiss = (s: Suggestion) => {
    onDecide(s.key, 'dismissed');
    sendReadFeedback(stored?.analysisId ?? null, [{ field: s.key, aiValue: s.to, confirmedValue: s.from, accepted: false }]);
  };

  if (!photoCount && !stored) return null;

  const button = (
    <Button variant={stored ? 'secondary' : 'primary'} size={stored ? 'md' : 'lg'} className="w-full" disabled={busy || !online || !photoCount} onClick={read}>
      {busy ? `Reading ${photoCount} photo${photoCount === 1 ? '' : 's'}… ${elapsed}s` : stored ? (newSinceRead ? '✨ Read again with the new photos' : '✨ Read again') : `✨ Read ${photoCount === 1 ? 'this photo' : `these ${photoCount} photos`}`}
    </Button>
  );

  return (
    <div className="space-y-3 rounded-2xl bg-gradient-to-b from-violet-50 to-white p-3 ring-1 ring-violet-200">
      {!stored ? (
        <>
          {button}
          <p className="text-xs text-slate-600">
            AI looks at the photos and fills in what it can see: existing insulation and depth, R-value, framing, access, removal, obstacles and hazards. You check each one before it changes the quote.
          </p>
        </>
      ) : null}
      <div role="status" aria-live="polite" className="contents">
      {busy ? (
        <div className="flex items-center justify-between gap-2 text-sm text-violet-900">
          <span>Looking at insulation, framing, access and hazards. Usually 20–60 seconds.</span>
          <Button size="sm" variant="ghost" onClick={() => runningRead(area.id)?.controller.abort()}>
            Stop
          </Button>
        </div>
      ) : null}
      {!online && photoCount ? <p className="text-sm text-slate-600">No signal. Photo reading needs a connection; the photos are saved and you can read them later.</p> : null}
      {!available && !error ? <Alert tone="blue">AI photo reading isn&apos;t switched on yet. The owner adds an Anthropic API key in Vercel (ANTHROPIC_API_KEY).</Alert> : null}
      {error ? <Alert>{error}</Alert> : null}
      </div>

      {stored ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-bold text-violet-900">✨ Photo read</h4>
            <span className="text-xs text-slate-500">{new Date(stored.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          <p className="text-sm text-slate-800">{stored.read.summary}</p>
          {!stored.read.matchesArea ? (
            <Alert>These photos look like {SPACE_WORDS[stored.read.spaceSeen] ?? 'something else'}, not this area. Nothing was suggested; check the photos.</Alert>
          ) : null}

          {stored.read.hazards.map((h, i) => (
            <Alert key={i} tone={h.severity === 'stop_work' ? 'red' : h.severity === 'caution' ? 'amber' : 'blue'}>
              <strong role={h.severity === 'stop_work' ? 'alert' : undefined}>{h.severity === 'stop_work' ? 'Stop: ' : ''}{HAZARD_LABELS[h.type]}</strong>
              {h.detail ? ` — ${h.detail}` : ''}
              {h.photoNumbers.length ? <span className="text-xs"> (photo {h.photoNumbers.join(', ')})</span> : null}
            </Alert>
          ))}

          {suggestions.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">Suggested changes</span>
                {inBatch.length > 1 ? (
                  <Button size="sm" onClick={() => apply(inBatch)}>
                    Apply all {inBatch.length}
                  </Button>
                ) : null}
              </div>
              {suggestions.map((s) => (
                <div key={s.key} className="rounded-xl bg-white p-3 ring-1 ring-slate-200">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold">
                        {s.label} <Badge tone={CONFIDENCE_TONE[s.confidence]}>{s.confidence}</Badge>
                      </div>
                      <div className="text-sm">
                        <span className="text-slate-500 line-through decoration-slate-300">{s.from}</span> → <strong>{s.to}</strong>
                      </div>
                      {s.why ? <p className="mt-1 whitespace-pre-line text-xs text-slate-600">{s.why}</p> : null}
                    </div>
                    <div className="flex shrink-0 flex-col gap-1">
                      <Button size="sm" onClick={() => apply([s])} aria-label={`Apply ${s.label}`}>
                        Apply
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => dismiss(s)} aria-label={`Skip ${s.label}`}>
                        Skip
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : stored.read.matchesArea ? (
            <p className="text-sm text-emerald-800">
              {all.length && decided.length
                ? `✓ All suggestions handled (${decided.filter((d) => d === 'applied').length} applied, ${decided.filter((d) => d === 'dismissed').length} skipped).`
                : '✓ The area matches what the photos show.'}
            </p>
          ) : null}

          <details className="rounded-xl bg-white p-3 text-sm ring-1 ring-slate-200">
            <summary className="cursor-pointer font-semibold text-slate-700">What it saw</summary>
            <dl className="mt-2 space-y-2">
              <Seen label={`Insulation (${stored.read.existingInsulation.confidence})`} text={stored.read.existingInsulation.evidence} />
              <Seen label={`Framing (${stored.read.framing.confidence})`} text={stored.read.framing.evidence} />
              <Seen label={`Size (${stored.read.size.confidence})`} text={stored.read.size.method} />
              <Seen label="Access" text={stored.read.access.reason} />
              <Seen label="Removal" text={`${stored.read.removal.recommended ? 'Recommended. ' : 'Not needed. '}${stored.read.removal.reason}`} />
              {stored.read.obstructions.length ? <Seen label="Obstacles" text={stored.read.obstructions.map((o) => `${o.count > 1 ? `${o.count} × ` : ''}${o.name}${o.detail ? ` (${o.detail})` : ''}`).join('; ')} /> : null}
              {stored.read.airSealing.length ? <Seen label="Air sealing" text={stored.read.airSealing.join('; ')} /> : null}
              {stored.read.estimatorNotes.length ? <Seen label="Notes" text={stored.read.estimatorNotes.join(' ')} /> : null}
            </dl>
          </details>
          {stored.read.photoTips.length ? (
            <p className="text-xs text-slate-600">
              <strong>For a better read:</strong> {stored.read.photoTips.join(' ')}
            </p>
          ) : null}
          {button}
        </div>
      ) : null}
    </div>
  );
}

function Seen({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-800">{text}</dd>
    </div>
  );
}
