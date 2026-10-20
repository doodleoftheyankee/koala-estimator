'use client';

// Option picker + e-sign form for the public quote page. Works with a finger on a phone.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Alert, Button, Card, Field, Input, cx } from '@/components/ui';
import { ESIGN_CONSENT } from '@/lib/quotes/consent';

type Tier = 'good' | 'better' | 'best';

export interface SignOption {
  tier: Tier;
  label: string;
  bullets: string[];
  items: Array<{ areaName: string; description: string; price: number }>;
  price: number;
  financingText: string | null;
}

const TIER_NAMES: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };

const usd = (n: number, cents = false) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 });

function SignaturePad({ onChange }: { onChange: (dataUrl: string | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const hasInk = useRef(false);

  const setup = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * ratio);
    canvas.height = Math.round(rect.height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    hasInk.current = false;
    onChange(null);
  }, [onChange]);

  useEffect(() => {
    setup();
    // Resizing clears the canvas, so the signature is reset when the layout width changes.
    let width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        setup();
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setup]);

  const point = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const p = point(e);
    last.current = p;
    const ctx = e.currentTarget.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
      ctx.fillStyle = '#0f172a';
      ctx.fill();
    }
    hasInk.current = true;
  };

  const onMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    e.preventDefault();
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
  };

  const onUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    drawing.current = false;
    last.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (hasInk.current) onChange(e.currentTarget.toDataURL('image/png'));
  };

  const clear = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    hasInk.current = false;
    onChange(null);
  };

  return (
    <div>
      <div className="relative rounded-xl bg-white ring-1 ring-slate-300">
        <canvas
          ref={canvasRef}
          aria-label="Signature pad: draw your signature with your finger or mouse"
          className="block h-44 w-full cursor-crosshair touch-none select-none rounded-xl"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
        />
        <div className="pointer-events-none absolute inset-x-4 bottom-8 border-b border-dashed border-slate-300" />
        <span className="pointer-events-none absolute bottom-2 left-4 text-xs text-slate-400">Sign above the line</span>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="secondary" size="sm" onClick={clear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

export function SignForm({
  token,
  options,
  recommendedTier,
  defaultTier,
  brandColor,
  pdfHref,
  children,
}: {
  token: string;
  options: SignOption[];
  recommendedTier: Tier | null;
  defaultTier: Tier | null;
  brandColor: string;
  pdfHref: string;
  children?: ReactNode;
}) {
  const [tier, setTier] = useState<Tier | null>(defaultTier);
  const [name, setName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const selected = options.find((o) => o.tier === tier) ?? null;
  const nameOk = name.trim().length >= 2 && name.trim().length <= 100;
  const canSubmit = !!selected && nameOk && !!signature && consent && !busy;

  const submit = async () => {
    if (!selected || !signature) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/quotes/${encodeURIComponent(token)}/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tier: selected.tier, signerName: name.trim(), signaturePng: signature, consent: true }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Something went wrong. Please try again.');
        return;
      }
      setDone(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done && selected) {
    return (
      <Card className="text-center">
        <p className="text-4xl" aria-hidden>
          ✓
        </p>
        <h2 className="mt-2 text-2xl font-bold text-slate-900">Thank you, {name.trim()}!</h2>
        <p className="mt-2 text-slate-700">
          You accepted {TIER_NAMES[selected.tier]}: {selected.label} for {usd(selected.price, true)}. We emailed you a copy and will contact you
          shortly to schedule the work.
        </p>
        <a
          href={pdfHref}
          className="mt-5 inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-5 font-semibold text-white hover:bg-brand-800"
        >
          Download your signed quote (PDF)
        </a>
      </Card>
    );
  }

  return (
    <>
      <section aria-labelledby="options-heading" className="space-y-3">
        <h2 id="options-heading" className="px-1 text-lg font-semibold text-slate-900">
          {options.length > 1 ? 'Choose your option' : 'Your option'}
        </h2>
        <div role="radiogroup" aria-labelledby="options-heading" className="space-y-3">
          {options.map((o) => {
            const active = o.tier === tier;
            return (
              <button
                key={o.tier}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setTier(o.tier)}
                className={cx(
                  'block w-full rounded-2xl bg-white p-4 text-left shadow-sm transition',
                  active ? 'ring-2' : 'ring-1 ring-slate-200 hover:ring-slate-300',
                )}
                style={active ? ({ '--tw-ring-color': brandColor } as CSSProperties) : undefined}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className="mt-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2"
                      style={{ borderColor: active ? brandColor : '#cbd5e1' }}
                    >
                      {active ? <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: brandColor }} /> : null}
                    </span>
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        {TIER_NAMES[o.tier]}
                        {o.tier === recommendedTier ? (
                          <span className="ml-2 rounded-full px-2 py-0.5 text-white" style={{ backgroundColor: brandColor }}>
                            Recommended
                          </span>
                        ) : null}
                      </p>
                      <p className="text-lg font-semibold text-slate-900">{o.label}</p>
                    </div>
                  </div>
                  <p className="shrink-0 text-xl font-bold text-slate-900">{usd(o.price)}</p>
                </div>
                {o.bullets.length ? (
                  <ul className="mt-3 list-disc space-y-1 pl-9 text-sm text-slate-700">
                    {o.bullets.map((b, i) => (
                      <li key={i}>{b}</li>
                    ))}
                  </ul>
                ) : null}
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                      <th className="py-1 pr-2 font-semibold">Area</th>
                      <th className="py-1 pr-2 font-semibold">Work</th>
                      <th className="py-1 text-right font-semibold">Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {o.items.map((it, i) => (
                      <tr key={i} className="border-b border-slate-100 align-top">
                        <td className="py-1.5 pr-2 text-slate-900">{it.areaName}</td>
                        <td className="py-1.5 pr-2 text-slate-700">{it.description}</td>
                        <td className="py-1.5 text-right text-slate-900">{usd(it.price)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {o.financingText ? <p className="mt-2 text-xs text-slate-600">{o.financingText}</p> : null}
              </button>
            );
          })}
        </div>
      </section>

      {children}

      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Accept and sign</h2>
        {selected ? (
          <p className="mt-1 text-slate-700">
            You are accepting <strong>{TIER_NAMES[selected.tier]}: {selected.label}</strong> for{' '}
            <strong>{usd(selected.price, true)}</strong>.
          </p>
        ) : (
          <p className="mt-1 text-slate-700">Choose an option above.</p>
        )}
        <div className="mt-4 space-y-4">
          <Field label="Your full name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              maxLength={100}
              placeholder="First and last name"
            />
          </Field>
          <div>
            <span className="mb-1 block text-sm font-medium text-slate-700">Your signature</span>
            <SignaturePad onChange={setSignature} />
          </div>
          <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-3 text-sm text-slate-800 ring-1 ring-slate-200">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="mt-0.5 h-6 w-6 shrink-0 accent-current"
              style={{ color: brandColor }}
            />
            <span>{ESIGN_CONSENT}</span>
          </label>
          {error ? <Alert tone="red">{error}</Alert> : null}
          <Button size="lg" className="w-full" disabled={!canSubmit} onClick={submit}>
            {busy ? 'Signing…' : selected ? `Sign and accept ${usd(selected.price)}` : 'Sign and accept'}
          </Button>
          {!canSubmit && !busy ? (
            <p className="text-center text-xs text-slate-500">
              {!selected
                ? 'Choose an option.'
                : !nameOk
                  ? 'Type your full name.'
                  : !signature
                    ? 'Draw your signature in the box.'
                    : !consent
                      ? 'Check the box to agree to sign electronically.'
                      : null}
            </p>
          ) : null}
        </div>
      </Card>
    </>
  );
}
