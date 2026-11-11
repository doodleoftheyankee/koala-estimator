'use client';
// "Read these photos": AI looks at the area's photos and suggests what to fill in (existing
// insulation, depth, R-value, access, removal, size, cutouts) and flags hazards. Nothing changes
// until the estimator taps Apply; every suggestion shows what it's based on and how sure it is.
import { useEffect, useRef, useState } from 'react';
import { db } from '@/lib/offline/db';
import type { LocalPhoto } from '@/lib/offline/photos';
import { photoReadAvailable, ReadFailed, requestPhotoRead, sendReadFeedback } from '@/lib/offline/photoRead';
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
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    let live = true;
    void photoReadAvailable().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const phonePhotos = local.filter((p) => p.state !== 'deleting').sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const known = new Set(local.map((p) => p.id));
  const serverPhotos = remote.filter((r) => r.areaId === area.id && !known.has(r.id));
  const photoCount = phonePhotos.length + serverPhotos.length;
  const currentIds = [...phonePhotos.map((p) => p.id), ...serverPhotos.map((r) => r.id)];
  const newSinceRead = stored ? currentIds.some((id) => !stored.photoIds.includes(id)) : false;

  const read = async () => {
    setError(null);
    setBusy(true);
    setElapsed(0);
    abort.current = new AbortController();
    try {
      const res = await requestPhotoRead(
        {
          ...context,
          areaId: area.id,
          areaName: area.name,
          jobType: area.jobType,
          sqft: area.sqft || null,
          measured: Boolean(measurement),
          currentR: area.currentR || null,
          existingMaterial: area.existingMaterial,
        },
        phonePhotos,
        serverPhotos,
        abort.current.signal,
      );
      onRead({ read: res.read, analysisId: res.analysisId, model: res.model, createdAt: res.createdAt, photoIds: res.photoIds, decisions: {} });
    } catch (e) {
      if (e instanceof ReadFailed) {
        if (e.code === 'aborted') return;
        if (e.code === 'not_configured') setAvailable(false);
        setError(e.message);
      } else setError('The photo read failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const suggestions = stored ? suggestionsFor(stored.read, area, measurement).filter((s) => !stored.decisions[s.key]) : [];
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
    <Button variant={stored ? 'secondary' : 'primary'} size={stored ? 'md' : 'lg'} className="w-full" disabled={busy || !online || !photoCount || !available} onClick={() => void read()}>
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
      {busy ? (
        <div className="flex items-center justify-between gap-2 text-sm text-violet-900">
          <span>Looking at insulation, framing, access and hazards. Usually 20–60 seconds.</span>
          <Button size="sm" variant="ghost" onClick={() => abort.current?.abort()}>
            Stop
          </Button>
        </div>
      ) : null}
      {!online && photoCount ? <p className="text-sm text-slate-600">No signal. Photo reading needs a connection; the photos are saved and you can read them later.</p> : null}
      {!available ? <Alert tone="blue">AI photo reading isn&apos;t switched on yet. The owner adds an Anthropic API key in Vercel (ANTHROPIC_API_KEY).</Alert> : null}
      {error && available ? <Alert>{error}</Alert> : null}

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
              <strong>{h.severity === 'stop_work' ? 'Stop: ' : ''}{HAZARD_LABELS[h.type]}</strong>
              {h.detail ? ` — ${h.detail}` : ''}
              {h.photoNumbers.length ? <span className="text-xs"> (photo {h.photoNumbers.join(', ')})</span> : null}
            </Alert>
          ))}

          {suggestions.length ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-slate-700">Suggested changes</span>
                {suggestions.length > 1 ? (
                  <Button size="sm" onClick={() => apply(suggestions)}>
                    Apply all {suggestions.length}
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
                      <Button size="sm" onClick={() => apply([s])}>
                        Apply
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => dismiss(s)} aria-label={`Dismiss ${s.label}`}>
                        Skip
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : stored.read.matchesArea ? (
            <p className="text-sm text-emerald-800">✓ The area matches what the photos show.</p>
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
