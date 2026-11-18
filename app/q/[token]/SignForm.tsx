'use client';

// The open quote: choose an option, see what it covers, and e-sign. Works with a finger on a phone.
//
// Quiet register (the layout sets it). The chosen option gets the pale hi-vis wash with an ink
// edge; the ONE hi-vis element on the page is "Review and sign" in the sign bar (a fixed bar on
// phones, a sticky card beside the quote on desktops). The signing form itself is unchanged in
// law: the same fields, the same consent text and the same submission.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Banner } from '@/components/daymark/Banner';
import { Button } from '@/components/daymark/Button';
import { CHOSEN_STYLE, RadioDot, onRovingKeys } from '@/components/daymark/chosen';
import { cx } from '@/components/daymark/cx';
import { Field, Input } from '@/components/daymark/Form';
import { SignLabel } from '@/components/daymark/Gauge';
import { Check, CircleCheck, Icon, Info, Signature, Star } from '@/components/daymark/icons';
import type { Tier } from '@/lib/pricing';
import { ESIGN_CONSENT } from '@/lib/quotes/consent';
import { ClosedState, PAGE, SectionTitle, TWO_COLUMNS, SignedSummary, PdfLink } from './parts';
import { price, priceExact, shortDate, tierName, type QuoteOptionView } from './quote-view';

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const scrollToEl = (el: Element | null) => el?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });

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
    // The signature image is stored with the signed quote: always dark ink on a clear background,
    // whatever theme the screen is in (the pad itself stays paper-white, see below).
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
      {/* Paper-white in every theme, so the dark signature ink always shows. */}
      <div data-theme="day" data-register="quiet" className="relative overflow-hidden rounded-control border-[length:var(--bw)] border-solid border-line-strong bg-surface">
        <canvas
          ref={canvasRef}
          aria-label="Signature pad: draw your signature with your finger or mouse"
          className="block h-44 w-full cursor-crosshair touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
        />
        <div aria-hidden className="pointer-events-none absolute inset-x-4 bottom-9 border-b-2 border-dashed border-line-strong" />
        <span aria-hidden className="pointer-events-none absolute bottom-2 left-4 text-[15px] font-semibold text-ink-3">
          Sign above the line
        </span>
      </div>
      <div className="mt-2 flex justify-end">
        <Button variant="secondary" size="sm" onClick={clear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/**
 * The chosen card: the register's chosen fill (the pale hi-vis wash here) and its ink edge, drawn
 * as the card's own border plus an inset ring up to --bw-go, so the edge is never under 2px and
 * never thinner than the other cards' edges (Sun+ draws them at 3px). Set inline: no class can
 * remove it.
 */
export const CHOSEN_CARD_STYLE: CSSProperties = {
  backgroundColor: CHOSEN_STYLE.backgroundColor,
  color: CHOSEN_STYLE.color,
  borderColor: 'var(--chosen-edge)',
  boxShadow: 'inset 0 0 0 max(0px, calc(var(--bw-go) - var(--bw))) var(--chosen-edge)',
};

/** rovingIndex: the chosen option takes the Tab stop (or the first when none is chosen). */
const rovingIndex = (on: boolean, i: number, anyOn: boolean) => (on || (!anyOn && i === 0) ? 0 : -1);

/**
 * The options as cards: stacked rows on phones (long names and the price line up), three across
 * from 640px. The chosen one gets the wash and an ink edge (CHOSEN_CARD_STYLE, set inline so no
 * class can remove the edge); the quote's recommended option carries an ink "Recommended" tag.
 */
function OptionCards({ options, value, recommendedTier, onChange }: { options: QuoteOptionView[]; value: Tier | null; recommendedTier: Tier | null; onChange: (t: Tier) => void }) {
  const anyOn = options.some((o) => o.tier === value);
  const anyRec = options.some((o) => o.tier === recommendedTier);
  return (
    <div
      role="radiogroup"
      aria-labelledby="options-heading"
      onKeyDown={(e) => onRovingKeys(e)}
      className={cx('mt-6 grid gap-4', options.length === 3 && 'sm:grid-cols-3', options.length === 2 && 'sm:grid-cols-2')}
    >
      {options.map((o, i) => {
        const on = o.tier === value;
        const rec = o.tier === recommendedTier;
        return (
          <button
            key={o.tier}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={rovingIndex(on, i, anyOn)}
            onClick={() => onChange(o.tier)}
            style={on ? CHOSEN_CARD_STYLE : undefined}
            className={cx(
              'relative flex w-full flex-col justify-start rounded-plate border-[length:var(--bw)] border-solid px-4 pb-4 text-left text-ink transition-colors duration-[var(--t-quick)]',
              // Room for the Recommended tag; side by side, every card starts at the same height.
              rec ? 'pt-6' : anyRec ? 'pt-4 sm:pt-6' : 'pt-4',
              !on && 'border-edge bg-surface hover:bg-sunken',
            )}
          >
            <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[auto_minmax(0,1fr)]">
              <span className="col-start-1 row-span-2 row-start-1 sm:row-span-1">
                <RadioDot on={on} />
              </span>
              <span className="sign-label col-start-2 row-start-1 text-ink-2">{tierName(o.tier)}</span>
              {rec ? (
                <span className="sign-label absolute -top-3 left-4 inline-flex h-6 items-center gap-1.5 rounded-tag bg-ink px-2.5 text-on-ink [--sign-size:11px]">
                  <Icon icon={Star} size="xs" />
                  Recommended
                </span>
              ) : null}
              <span className="col-start-2 row-start-2 text-[16px] leading-snug font-bold sm:col-span-2 sm:col-start-1 sm:row-start-3 sm:mt-1">{o.label}</span>
              <span className="gauge col-start-3 row-span-2 row-start-1 text-right text-[34px] sm:col-span-2 sm:col-start-1 sm:row-span-1 sm:row-start-2 sm:mt-2 sm:text-left sm:text-[40px]">
                {price(o.price)}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The chosen option in full: what's included, what the price covers, and its total. */
function ChosenDetail({ option }: { option: QuoteOptionView }) {
  const fin = option.financing;
  return (
    <div className="plate mt-4 overflow-hidden">
      <div className="p-4 sm:p-5">
        <SignLabel>{tierName(option.tier)} · Your choice</SignLabel>
        <h3 className="mt-2 text-[24px] leading-tight font-extrabold text-ink">{option.label}</h3>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <span className="gauge text-[60px] text-ink sm:text-[64px]">{price(option.price)}</span>
          {fin ? (
            <p className="text-right text-[15px] leading-snug font-semibold text-ink-2">
              or about
              <span className="gauge-m block text-[26px] text-ink">
                {fin.monthly}/mo<sup aria-hidden>1</sup>
              </span>
              for {fin.termMonths} months
            </p>
          ) : null}
        </div>
        {option.bullets.length ? (
          <ul aria-label="What’s included" className="mt-5 space-y-2.5">
            {option.bullets.map((b, i) => (
              <li key={i} className="flex gap-2.5 text-[16.5px] leading-snug font-semibold text-ink">
                <Icon icon={Check} size="s" className="mt-0.5 text-ok" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {option.items.length ? (
        <table className="w-full border-t-[length:var(--bw)] border-solid border-edge text-left">
          <caption className="sr-only">What the price covers</caption>
          <thead className="sr-only">
            <tr>
              <th scope="col">Work</th>
              <th scope="col">Price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {option.items.map((it, i) => (
              <tr key={i} className="align-top">
                <td className="py-3 pr-2 pl-4 sm:pl-5">
                  <SignLabel size={11} tone="ink-3">
                    {it.areaName}
                  </SignLabel>
                  <span className="mt-1 block text-[16px] leading-snug font-semibold text-ink">{it.description}</span>
                </td>
                <td className="gauge-m py-3 pr-4 pl-2 text-right text-[20px] whitespace-nowrap text-ink sm:pr-5">{price(it.price)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-[length:var(--bw-x)] border-solid border-rule bg-sunken">
              <th scope="row" className="py-3.5 pr-2 pl-4 text-[17px] font-extrabold text-ink sm:pl-5">
                Total
              </th>
              <td className="gauge-m py-3.5 pr-4 pl-2 text-right text-[26px] whitespace-nowrap text-ink sm:pr-5">{price(option.price)}</td>
            </tr>
          </tfoot>
        </table>
      ) : null}
      {fin ? (
        <p className="border-t-[length:var(--bw)] border-solid border-line px-4 py-3 text-[15px] leading-snug font-medium text-ink-2 sm:px-5">
          <sup aria-hidden>1</sup> {fin.line}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The sign bar: the chosen option, its price and "Review and sign", the page's one hi-vis button.
 * Phones: fixed to the bottom edge; it steps aside while the sign form is on screen, where the
 * Sign and accept button repeats the price. Desktops: a sticky card beside the quote.
 */
function SignBar({ option, validUntil, hidden, onReview }: { option: QuoteOptionView; validUntil: string; hidden: boolean; onReview: () => void }) {
  return (
    <aside
      aria-label="Your choice"
      className={cx(
        'z-30 bg-surface print:hidden',
        'max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:border-t-[length:var(--bw-x)] max-lg:border-solid max-lg:border-rule max-lg:px-4 max-lg:pt-3 max-lg:pb-[max(12px,var(--safe-bottom))] max-lg:transition-[translate,visibility] max-lg:duration-[var(--t-move)] max-lg:ease-[var(--ease)]',
        'lg:plate lg:p-5',
        hidden && 'max-lg:invisible max-lg:translate-y-full',
      )}
    >
      <div className="mx-auto flex max-w-2xl items-center gap-4 lg:block">
        <div className="min-w-0 shrink-0 lg:hidden">
          <SignLabel size={11.5}>{tierName(option.tier)}</SignLabel>
          <span className="gauge mt-1 block text-[32px] text-ink">{price(option.price)}</span>
        </div>
        <div className="hidden lg:block">
          <SignLabel>Your choice</SignLabel>
          <p className="mt-2 text-[20px] leading-tight font-extrabold text-ink">
            {tierName(option.tier)}: {option.label}
          </p>
          <span className="gauge mt-4 block text-[56px] text-ink">{price(option.price)}</span>
          {option.financing ? (
            <p className="mt-2 text-[15px] leading-snug font-semibold text-ink-2">
              or about {option.financing.monthly}/mo for {option.financing.termMonths} months
            </p>
          ) : null}
        </div>
        <Button variant="primary" size="lg" icon={Signature} onClick={onReview} className="flex-1 lg:mt-5 lg:w-full">
          Review and sign
        </Button>
        <p className="mt-3 hidden text-[15px] leading-snug font-semibold text-ink-2 lg:block">Price holds until {shortDate(validUntil)}</p>
      </div>
    </aside>
  );
}

export function SignForm({
  token,
  options,
  recommendedTier,
  defaultTier,
  pdfHref,
  quoteNumber,
  validUntil,
  intro,
  contacts,
  contactsAside,
  children,
}: {
  token: string;
  options: QuoteOptionView[];
  recommendedTier: Tier | null;
  defaultTier: Tier | null;
  pdfHref: string;
  quoteNumber: string;
  validUntil: string;
  /** Quote number, title, customer and the info tiles (server-rendered). */
  intro: ReactNode;
  /** Who to ask (server-rendered), also shown once the quote is signed. */
  contacts: ReactNode;
  /** The same, for the desktop column beside the quote (its own heading id). */
  contactsAside?: ReactNode;
  /** Notes, warranty and terms (server-rendered), between the options and the sign form. */
  children?: ReactNode;
}) {
  const [tier, setTier] = useState<Tier | null>(defaultTier);
  const [name, setName] = useState('');
  const [signature, setSignature] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [signInView, setSignInView] = useState(false);
  const signRef = useRef<HTMLElement>(null);
  const optionsRef = useRef<HTMLElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.tier === tier) ?? null;
  const nameOk = name.trim().length >= 2 && name.trim().length <= 100;
  const canSubmit = !!selected && nameOk && !!signature && consent && !busy;

  // Phones: the sign bar steps aside while the sign form is on screen (above the bar's height).
  useEffect(() => {
    const el = signRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => setSignInView(!!entry?.isIntersecting), { rootMargin: '0px 0px -96px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [done]);

  // Once signed, the thank-you title takes focus so screen readers announce the result.
  useEffect(() => {
    if (done) document.getElementById('signed-title')?.focus({ preventScroll: true });
  }, [done]);

  const review = () => {
    scrollToEl(signRef.current);
    nameRef.current?.focus({ preventScroll: true });
  };

  const changeOption = () => {
    scrollToEl(optionsRef.current);
    optionsRef.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]')?.focus({ preventScroll: true });
  };

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
      window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done && selected) {
    return (
      <ClosedState
        quoteNumber={quoteNumber}
        icon={CircleCheck}
        tone="ok"
        titleId="signed-title"
        title={`Thank you, ${name.trim()}!`}
        action={<PdfLink href={pdfHref}>Download your signed quote (PDF)</PdfLink>}
        aside={contacts}
      >
        <SignedSummary tier={selected.tier} label={selected.label} price={selected.price} />
        <p>
          You accepted {tierName(selected.tier)}: {selected.label} for {priceExact(selected.price)}. We emailed you a copy and will contact you shortly to
          schedule the work.
        </p>
      </ClosedState>
    );
  }

  const reason = !selected
    ? 'Choose an option.'
    : !nameOk
      ? 'Type your full name.'
      : !signature
        ? 'Draw your signature in the box.'
        : !consent
          ? 'Check the box to agree to sign electronically.'
          : null;

  return (
    <main id="main" className={cx(PAGE, TWO_COLUMNS, 'pt-6 lg:pt-10')}>
      <div className="min-w-0 space-y-10">
        {intro}

        <section ref={optionsRef} aria-labelledby="options-heading" className="scroll-mt-4">
          <SectionTitle id="options-heading">{options.length > 1 ? 'Choose your option' : 'Your option'}</SectionTitle>
          <OptionCards options={options} value={tier} recommendedTier={recommendedTier} onChange={setTier} />
          {selected ? <ChosenDetail option={selected} /> : null}
        </section>

        {children}

        <div className={contactsAside ? 'lg:hidden' : undefined}>{contacts}</div>

        <section ref={signRef} id="sign" aria-labelledby="sign-heading" className="scroll-mt-4">
          <SectionTitle id="sign-heading">Accept and sign</SectionTitle>
          <div className="plate mt-5 p-4 sm:p-5">
            {selected ? (
              <div>
                <p className="text-[17px] leading-snug font-medium text-ink">
                  You are accepting{' '}
                  <strong className="font-extrabold">
                    {tierName(selected.tier)}: {selected.label}
                  </strong>{' '}
                  for <strong className="font-extrabold">{priceExact(selected.price)}</strong>.
                </p>
                {options.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={changeOption} className="-mb-2 -ml-4 underline underline-offset-4">
                    Change option
                  </Button>
                ) : null}
              </div>
            ) : (
              <p className="text-[17px] font-medium text-ink">Choose an option above.</p>
            )}
            <div className="mt-5 space-y-5">
              <Field label="Your full name">
                <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} placeholder="First and last name" />
              </Field>
              <div>
                <span className="mb-1.5 block text-[16px] leading-snug font-bold text-ink">Your signature</span>
                <SignaturePad onChange={setSignature} />
              </div>
              <label className="flex cursor-pointer items-start gap-3 rounded-control border-[length:var(--bw)] border-solid border-line bg-sunken p-3.5 text-[15.5px] leading-snug font-medium text-ink">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                  className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer"
                  style={{ accentColor: 'var(--ink)' }}
                />
                <span>{ESIGN_CONSENT}</span>
              </label>
              {error ? <Banner tone="bad">{error}</Banner> : null}
              <div>
                <Button variant="main" size="lg" block icon={busy ? undefined : Signature} disabled={!canSubmit} onClick={submit}>
                  {busy ? 'Signing…' : selected ? `Sign and accept ${price(selected.price)}` : 'Sign and accept'}
                </Button>
                {!canSubmit && !busy && reason ? (
                  <p className="mt-2.5 flex items-start gap-2 text-[15px] leading-snug font-semibold text-ink-2">
                    <Icon icon={Info} size="s" className="mt-px" />
                    {reason}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {/* Room under the sign form for the phone's sign bar. */}
        <div aria-hidden className="h-[calc(88px+var(--safe-bottom))] lg:hidden" />
      </div>

      <div className="lg:sticky lg:top-6 lg:space-y-6">
        {selected ? <SignBar option={selected} validUntil={validUntil} hidden={signInView} onReview={review} /> : null}
        {contactsAside ? <div className="hidden lg:block">{contactsAside}</div> : null}
      </div>
    </main>
  );
}
