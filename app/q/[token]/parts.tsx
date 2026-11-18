// Building blocks of the customer quote pages, in Daymark's quiet register (the layout sets it):
// 1px rules, no keel, plain-zero digits. They hold no state, so both the server page and the
// client sign form use them.
//
// Every name, phone, licence and email comes from the franchise's branding (frozen into the quote
// when it was sent, or its settings) or from the quote itself; nothing about a franchise is typed
// in here. The franchise colour appears only in its logo tile, never behind text.
import type { ReactNode } from 'react';
import { Globe } from 'lucide-react';
import { buttonClass, buttonStyle } from '@/components/daymark/Button';
import { cx } from '@/components/daymark/cx';
import { SignLabel } from '@/components/daymark/Gauge';
import { StatusBadge } from '@/components/daymark/StatusBadge';
import { Download, Icon, Mail, Phone, type LucideIcon } from '@/components/daymark/icons';
import type { Tier } from '@/lib/pricing';
import { DEFAULT_BRAND_COLOR, type Branding, type QuoteDocument } from '@/lib/quotes/model';
import { initials, licenseLine, priceExact, shortDate, telHref, tierName, webHref } from './quote-view';

/** The page column: one column on phones, the wide two-column grid from 1024px. */
export const PAGE = 'mx-auto w-full max-w-2xl px-4 lg:max-w-6xl';
export const TWO_COLUMNS = 'lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)] lg:items-start lg:gap-10';

/** A 48px square link with an icon, named for screen readers (call, email). */
function IconLink({ href, icon, label, text }: { href: string; icon: LucideIcon; label: string; text?: string }) {
  return (
    <a href={href} aria-label={label} title={label} className={buttonClass({ variant: 'secondary', size: 'sm' }, cx('shrink-0', text ? 'w-12 px-0 sm:w-auto sm:px-4' : 'w-12 px-0'))}>
      <Icon icon={icon} />
      {text ? <span className="hidden sm:inline">{text}</span> : null}
    </a>
  );
}

function tileColor(b: Branding): string {
  return /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(b.primaryColor) ? b.primaryColor : DEFAULT_BRAND_COLOR;
}

/** The franchise's logo, or its colour in a plain tile when it has no logo (no text on it). */
function LogoTile({ branding, className = 'h-11 w-11' }: { branding: Branding; className?: string }) {
  const box = cx('shrink-0 rounded-control border-solid border-[length:var(--bw)] border-edge', className);
  if (branding.logoUrl) {
    // A franchise logo from its settings (an https URL the PDF uses too). The name sits beside it.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={branding.logoUrl} alt="" className={cx(box, 'bg-surface object-contain p-1')} />;
  }
  return <span aria-hidden className={box} style={{ backgroundColor: tileColor(branding) }} />;
}

/**
 * The franchise header on every quote page, open or closed: logo tile, name, phone and licence
 * line, and a Call button. With no branding at all (the database could not be read) it is a
 * plain rule.
 */
export function Masthead({ branding }: { branding: Branding | null }) {
  if (!branding) return <div aria-hidden className="h-[var(--bw-x)] bg-rule" />;
  const sub = [branding.phone, licenseLine(branding)].filter((x): x is string => !!x);
  return (
    <header className="border-b-[length:var(--bw-x)] border-solid border-rule bg-surface print:border-b">
      <div className={cx(PAGE, 'flex items-center gap-3 py-3 lg:py-4')}>
        <LogoTile branding={branding} />
        <div className="min-w-0 flex-1">
          <p className="text-[18px] leading-tight font-extrabold text-ink sm:text-[20px]">{branding.company}</p>
          {sub.length ? <p className="mt-0.5 text-[15px] leading-snug font-semibold text-ink-2">{sub.join(' · ')}</p> : null}
        </div>
        {branding.phone ? <IconLink href={telHref(branding.phone)} icon={Phone} label={`Call ${branding.company} at ${branding.phone}`} text="Call" /> : null}
      </div>
    </header>
  );
}

/** "Quote KN-2026-…" over the page title. */
export function QuoteNumber({ value }: { value: string }) {
  return <SignLabel tone="ink-2">Quote {value}</SignLabel>;
}

/** The screen title (Display, 30px; 36px on desktops). */
export function PageTitle({ children, className, id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <h1 id={id} tabIndex={id ? -1 : undefined} className={cx('text-[30px] leading-[1.07] font-extrabold tracking-[-0.02em] text-ink outline-none lg:text-[36px]', className)}>
      {children}
    </h1>
  );
}

/** A section title with a rule that fills the row. */
export function SectionTitle({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-3', className)}>
      <h2 id={id} className="shrink-0 text-[22px] leading-tight font-extrabold text-ink">
        {children}
      </h2>
      <span aria-hidden className="h-[var(--bw-x)] min-w-6 flex-1 rounded-sm bg-rule" />
    </div>
  );
}

/** Quote number, title, who it is for and where, then the two info tiles. */
export function QuoteIntro({ doc }: { doc: QuoteDocument }) {
  return (
    <div>
      <QuoteNumber value={doc.quoteNumber} />
      <PageTitle className="mt-2">Your insulation quote</PageTitle>
      <p className="mt-3 text-[17px] leading-snug font-medium text-ink-2">
        For <strong className="font-extrabold text-ink">{doc.customer.name}</strong>
      </p>
      <address className="text-[17px] leading-snug font-medium text-ink-2 not-italic">
        {[doc.property.line1, doc.property.line2].filter(Boolean).join(', ')}
      </address>
      <dl className="plate mt-5 grid grid-cols-2 overflow-hidden">
        <div className="min-w-0 px-3.5 py-3.5 sm:px-4">
          <dt>
            <SignLabel size={11}>Price holds until</SignLabel>
          </dt>
          <dd className="mt-1.5 text-[18px] leading-tight font-extrabold text-ink sm:text-[19px]">{shortDate(doc.validUntil)}</dd>
        </div>
        <div className="min-w-0 border-l-[length:var(--bw)] border-solid border-edge px-3.5 py-3.5 sm:px-4">
          <dt>
            <SignLabel size={11}>Your estimator</SignLabel>
          </dt>
          <dd className="mt-1.5 text-[18px] leading-tight font-extrabold break-words text-ink sm:text-[19px]">{doc.estimator.name}</dd>
        </div>
      </dl>
    </div>
  );
}

/** The estimator's notes, when the quote has any. */
export function NotesCard({ notes }: { notes: string }) {
  return (
    <section aria-labelledby="notes-heading" className="plate p-4 sm:p-5">
      <h2 id="notes-heading" className="text-[19px] leading-tight font-extrabold text-ink">
        Notes from your estimator
      </h2>
      <p className="mt-2 text-[17px] leading-relaxed font-medium whitespace-pre-line text-ink-2">{notes}</p>
    </section>
  );
}

/** Warranty and terms as the franchise wrote them, and the PDF of the whole quote. */
export function TermsCard({ doc, pdfHref }: { doc: QuoteDocument; pdfHref: string }) {
  return (
    <section aria-labelledby="terms-heading" className="plate overflow-hidden">
      <h2 id="terms-heading" className="sr-only">
        Warranty and terms
      </h2>
      <div className="divide-y divide-line">
        <div className="p-4 sm:p-5">
          <h3 className="text-[19px] leading-tight font-extrabold text-ink">Warranty</h3>
          <p className="mt-2 text-[16px] leading-relaxed font-medium whitespace-pre-line text-ink-2">{doc.warranty}</p>
        </div>
        <div className="p-4 sm:p-5">
          <h3 className="text-[19px] leading-tight font-extrabold text-ink">Terms</h3>
          <p className="mt-2 text-[16px] leading-relaxed font-medium whitespace-pre-line text-ink-2">{doc.terms}</p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 bg-sunken p-4 sm:px-5">
          <span className="min-w-0 text-[15px] font-semibold text-ink-2">The whole quote as a PDF, to keep or print.</span>
          <a href={pdfHref} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
            <Icon icon={Download} />
            Download PDF
          </a>
        </div>
      </div>
    </section>
  );
}

/**
 * Who to ask: the estimator (from the quote) and the franchise office (from its branding).
 * Shown on the open quote and on every closed state.
 */
export function ContactCard({
  estimator,
  branding,
  headingId = 'contact-heading',
}: {
  estimator: QuoteDocument['estimator'] | null;
  branding: Branding | null;
  /** Unique per page when the card appears twice (the desktop column and the phone flow). */
  headingId?: string;
}) {
  const officeLinks = branding
    ? [
        branding.email ? { href: `mailto:${branding.email}`, text: branding.email, icon: Mail } : null,
        branding.website ? { href: webHref(branding.website), text: branding.website, icon: Globe } : null,
      ].filter((x): x is { href: string; text: string; icon: LucideIcon } => !!x)
    : [];
  // The office row only when it gives a way to reach the office.
  const office = branding && (branding.phone || officeLinks.length) ? branding : null;
  if (!estimator && !office) return null;
  return (
    <section aria-labelledby={headingId} className="plate p-4 sm:p-5">
      <h2 id={headingId} className="text-[19px] leading-tight font-extrabold text-ink">
        Questions about this quote?
      </h2>
      <ul className="mt-2 divide-y divide-line">
        {estimator ? (
          <li className="flex items-center gap-3 py-3">
            <span aria-hidden className="gauge-m flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-ink text-[18px] text-on-ink">
              {initials(estimator.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[17px] leading-tight font-extrabold break-words text-ink">{estimator.name}</p>
              <p className="mt-0.5 text-[15px] leading-snug font-semibold break-words text-ink-2">
                Your estimator
                {estimator.email ? (
                  <>
                    {' · '}
                    <a href={`mailto:${estimator.email}`} className="underline underline-offset-2">
                      {estimator.email}
                    </a>
                  </>
                ) : null}
              </p>
            </div>
            {estimator.email ? <IconLink href={`mailto:${estimator.email}`} icon={Mail} label={`Email ${estimator.name}`} /> : null}
          </li>
        ) : null}
        {office ? (
          <li className="flex items-center gap-3 py-3">
            <LogoTile branding={office} className="h-12 w-12" />
            <div className="min-w-0 flex-1">
              <p className="text-[17px] leading-tight font-extrabold break-words text-ink">{office.company}</p>
              {office.phone ? <p className="mt-0.5 text-[15px] leading-snug font-semibold text-ink-2">{office.phone}</p> : null}
              {officeLinks.map((l) => (
                <a key={l.href} href={l.href} className="mt-0.5 flex items-center gap-1.5 text-[15px] font-semibold break-all text-ink-2 underline underline-offset-2">
                  <Icon icon={l.icon} size="xs" />
                  {l.text}
                </a>
              ))}
            </div>
            {office.phone ? <IconLink href={telHref(office.phone)} icon={Phone} label={`Call ${office.company} at ${office.phone}`} /> : null}
          </li>
        ) : null}
      </ul>
    </section>
  );
}

/**
 * A quote that can no longer be signed here (signed, a newer version, declined, expired), or a
 * link that leads nowhere. Same header above it; the quote number when there is one; what
 * happened in plain words; ONE clear action; and who to ask beside it.
 */
export function ClosedState({
  quoteNumber,
  icon,
  tone = 'ink',
  title,
  children,
  action,
  aside,
  titleId,
}: {
  /** Gives the title an id and makes it focusable, so a page can move focus to it. */
  titleId?: string;
  quoteNumber?: string | null;
  icon: LucideIcon;
  tone?: 'ink' | 'ok' | 'info' | 'warn';
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  aside?: ReactNode;
}) {
  const toneClass = { ink: 'text-ink', ok: 'text-ok', info: 'text-info', warn: 'text-warn' }[tone];
  return (
    <main id="main" className={cx(PAGE, TWO_COLUMNS, 'pt-6 pb-16 lg:pt-10')}>
      <div className="min-w-0">
        {quoteNumber ? <QuoteNumber value={quoteNumber} /> : null}
        <span className={cx('mt-4 block', toneClass)}>
          <Icon icon={icon} size="xl" />
        </span>
        <PageTitle className="mt-3" id={titleId}>
          {title}
        </PageTitle>
        {children ? <div className="mt-3 space-y-3 text-[17px] leading-relaxed font-medium text-ink-2">{children}</div> : null}
        {action ? <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">{action}</div> : null}
      </div>
      {aside ? <div className="mt-8 min-w-0 lg:mt-0">{aside}</div> : null}
    </main>
  );
}

/** The one action after signing: the signed PDF, as a filled ink button. */
export function PdfLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} className={buttonClass({ variant: 'main', size: 'lg' })} style={buttonStyle('main', false)}>
      <Icon icon={Download} />
      {children}
    </a>
  );
}

/** What was signed: the option, its name and the signed price (to the cent, as on the PDF). */
export function SignedSummary({ tier, label, price }: { tier: Tier | null; label: string | null; price: number | null }) {
  return (
    <div className="plate p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SignLabel>{tier ? tierName(tier) : 'Your option'}</SignLabel>
        <StatusBadge status="signed" />
      </div>
      {label ? <p className="mt-2 text-[20px] leading-tight font-extrabold text-ink">{label}</p> : null}
      {price !== null ? <span className="gauge mt-3 block text-[44px] text-ink">{priceExact(price)}</span> : null}
    </div>
  );
}

/** The office phone as a link inside a sentence, or "our office" when there is none. */
export function OfficeContact({ branding }: { branding: Branding | null }) {
  return branding?.phone ? (
    <a className="font-extrabold whitespace-nowrap text-ink underline underline-offset-2" href={telHref(branding.phone)}>
      {branding.phone}
    </a>
  ) : (
    <span className="font-extrabold text-ink">our office</span>
  );
}

/** The one action of a closed state: call the office when it has a phone, else email the estimator. */
export function ReachUsAction({ branding, estimator }: { branding: Branding | null; estimator: QuoteDocument['estimator'] | null }) {
  if (branding?.phone) {
    return (
      <a href={telHref(branding.phone)} className={buttonClass({ variant: 'main' })} style={buttonStyle('main', false)}>
        <Icon icon={Phone} />
        Call {branding.phone}
      </a>
    );
  }
  if (estimator?.email) {
    return (
      <a href={`mailto:${estimator.email}`} className={buttonClass({ variant: 'main' })} style={buttonStyle('main', false)}>
        <Icon icon={Mail} />
        Email {estimator.name}
      </a>
    );
  }
  if (branding?.email) {
    return (
      <a href={`mailto:${branding.email}`} className={buttonClass({ variant: 'main' })} style={buttonStyle('main', false)}>
        <Icon icon={Mail} />
        Email {branding.company}
      </a>
    );
  }
  return null;
}
