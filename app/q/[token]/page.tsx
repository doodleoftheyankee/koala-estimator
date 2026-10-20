// The customer's quote page: review options, download the PDF, and e-sign.
// Public (no session). Renders only snapshot.document, which never contains costs.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { Alert, Card } from '@/components/ui';
import { financingLine } from '@/lib/quotes/email';
import { findQuoteByToken, isExpired, type PublicQuoteRow } from '@/lib/quotes/lookup';
import { DEFAULT_BRAND_COLOR, formatUsd, type QuoteDocument } from '@/lib/quotes/model';
import { createAdminClient } from '@/lib/supabase/admin';
import { SignForm, type SignOption } from './SignForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Your insulation quote' },
  robots: { index: false, follow: false },
};

const TIER_NAMES = { good: 'Good', better: 'Better', best: 'Best' } as const;
const VIEW_DEDUPE_MS = 30 * 60 * 1000;

function fmtDate(iso: string): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function brandColor(doc: QuoteDocument): string {
  return /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(doc.branding.primaryColor) ? doc.branding.primaryColor : DEFAULT_BRAND_COLOR;
}

/** Records a customer view. Best-effort: a failure here must not break the page. */
async function recordView(admin: ReturnType<typeof createAdminClient>, quote: PublicQuoteRow): Promise<void> {
  const now = new Date();
  try {
    if (!quote.first_viewed_at) {
      await admin.from('quotes').update({ first_viewed_at: now.toISOString() }).eq('id', quote.id).is('first_viewed_at', null);
    }
    if (quote.status === 'sent') {
      await admin.from('quotes').update({ status: 'viewed' }).eq('id', quote.id).eq('status', 'sent');
    }
    const since = new Date(now.getTime() - VIEW_DEDUPE_MS).toISOString();
    const recent = await admin
      .from('quote_events')
      .select('id')
      .eq('quote_id', quote.id)
      .eq('event', 'viewed')
      .gte('at', since)
      .limit(1);
    if (!recent.error && (recent.data ?? []).length === 0) {
      await admin.from('quote_events').insert({ quote_id: quote.id, event: 'viewed', meta: { version: quote.version } });
    }
    await admin.from('estimates').update({ status: 'viewed' }).eq('id', quote.estimate_id).eq('status', 'sent');
  } catch (e) {
    console.error('[quote page] recording view failed', e instanceof Error ? e.message : e);
  }
}

function Shell({ doc, children }: { doc: QuoteDocument; children: ReactNode }) {
  const b = doc.branding;
  const color = brandColor(doc);
  const contact = [b.phone, b.email, b.website].filter((x): x is string => !!x);
  return (
    <div className="min-h-dvh bg-slate-50 pb-16">
      <header className="px-4 pb-5 pt-6 text-white" style={{ backgroundColor: color }}>
        <div className="mx-auto max-w-2xl">
          <p className="text-xl font-bold">{b.company}</p>
          {b.license ? <p className="text-sm opacity-90">License {b.license}</p> : null}
          {contact.length ? <p className="mt-1 text-sm opacity-90">{contact.join(' · ')}</p> : null}
        </div>
      </header>
      <main className="mx-auto max-w-2xl space-y-4 px-4 pt-4">{children}</main>
    </div>
  );
}

function QuoteHeader({ doc }: { doc: QuoteDocument }) {
  return (
    <Card>
      <h1 className="text-2xl font-bold text-slate-900">Your insulation quote</h1>
      <p className="mt-1 text-sm text-slate-500">
        No. {doc.quoteNumber} · Issued {fmtDate(doc.issuedAt)} · Valid until {fmtDate(doc.validUntil)}
      </p>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-semibold uppercase tracking-wide text-slate-500">Prepared for</dt>
          <dd className="text-slate-900">{doc.customer.name}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-slate-500">Property</dt>
          <dd className="text-slate-900">
            {doc.property.line1}
            <br />
            {doc.property.line2}
          </dd>
        </div>
        <div>
          <dt className="font-semibold uppercase tracking-wide text-slate-500">Your estimator</dt>
          <dd className="text-slate-900">
            {doc.estimator.name}
            {doc.estimator.email ? (
              <>
                <br />
                <a className="text-brand-800 underline" href={`mailto:${doc.estimator.email}`}>
                  {doc.estimator.email}
                </a>
              </>
            ) : null}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function OfficeContact({ doc }: { doc: QuoteDocument }) {
  const phone = doc.branding.phone;
  return phone ? (
    <a className="font-semibold underline" href={`tel:${phone.replace(/[^\d+]/g, '')}`}>
      {phone}
    </a>
  ) : (
    <span className="font-semibold">our office</span>
  );
}

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const admin = createAdminClient();
  const quote = await findQuoteByToken(admin, token);
  if (!quote) notFound();
  const doc = quote.document;
  const pdfHref = `/api/public/quotes/${token}/pdf`;

  if (quote.status === 'signed') {
    const opt = quote.signed_tier ? doc.options.find((o) => o.tier === quote.signed_tier) : undefined;
    const price = quote.signed_price !== null ? Number(quote.signed_price) : (opt?.price ?? null);
    return (
      <Shell doc={doc}>
        <Card className="text-center">
          <p className="text-4xl" aria-hidden>
            ✓
          </p>
          <h1 className="mt-2 text-2xl font-bold text-slate-900">Thank you{quote.signer_name ? `, ${quote.signer_name}` : ''}!</h1>
          <p className="mt-2 text-slate-700">
            Your quote {doc.quoteNumber} was signed{quote.signed_at ? ` on ${fmtDate(quote.signed_at)}` : ''}.
          </p>
          {quote.signed_tier ? (
            <p className="mt-3 text-lg text-slate-900">
              {TIER_NAMES[quote.signed_tier]}
              {opt ? `: ${opt.label}` : ''}
              {price !== null ? ` · ${formatUsd(price, true)}` : ''}
            </p>
          ) : null}
          <p className="mt-3 text-slate-700">
            We will contact you shortly to schedule the work. Questions? Call <OfficeContact doc={doc} />.
          </p>
          <a
            href={pdfHref}
            className="mt-5 inline-flex min-h-12 items-center justify-center rounded-xl bg-brand-700 px-5 font-semibold text-white hover:bg-brand-800"
          >
            Download your signed quote (PDF)
          </a>
        </Card>
      </Shell>
    );
  }

  if (quote.status === 'superseded') {
    return (
      <Shell doc={doc}>
        <Alert tone="blue">
          <p className="text-base">
            A newer version of this quote was sent to you. Please use the link in the most recent email, or contact <OfficeContact doc={doc} />.
          </p>
        </Alert>
      </Shell>
    );
  }

  if (quote.status === 'declined') {
    return (
      <Shell doc={doc}>
        <Alert tone="amber">
          <p className="text-base">
            This quote is no longer open. If you would like an updated quote, contact <OfficeContact doc={doc} />.
          </p>
        </Alert>
      </Shell>
    );
  }

  if (quote.status === 'expired' || isExpired(quote)) {
    return (
      <Shell doc={doc}>
        <Alert tone="amber">
          <p className="text-base">
            This quote expired on {fmtDate(doc.validUntil)}. Prices may have changed; please call <OfficeContact doc={doc} /> for an updated
            quote.
          </p>
        </Alert>
      </Shell>
    );
  }

  await recordView(admin, quote);

  const options: SignOption[] = doc.options.map((o) => ({
    tier: o.tier,
    label: o.label,
    bullets: o.bullets,
    items: o.items,
    price: o.price,
    financingText: o.financing ? financingLine(o.financing) : null,
  }));
  const defaultTier = doc.recommendedTier && options.some((o) => o.tier === doc.recommendedTier) ? doc.recommendedTier : (options[0]?.tier ?? null);

  return (
    <Shell doc={doc}>
      <QuoteHeader doc={doc} />
      <SignForm token={token} options={options} recommendedTier={doc.recommendedTier} defaultTier={defaultTier} brandColor={brandColor(doc)} pdfHref={pdfHref}>
        {doc.notes ? (
          <Card>
            <h2 className="text-lg font-semibold text-slate-900">Notes</h2>
            <p className="mt-1 whitespace-pre-line text-slate-700">{doc.notes}</p>
          </Card>
        ) : null}
        <Card>
          <h2 className="text-lg font-semibold text-slate-900">Warranty</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{doc.warranty}</p>
          <h2 className="mt-4 text-lg font-semibold text-slate-900">Terms</h2>
          <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{doc.terms}</p>
          <a
            href={pdfHref}
            className="mt-4 inline-flex min-h-12 items-center justify-center rounded-xl bg-white px-4 font-semibold text-slate-900 ring-1 ring-slate-300 hover:bg-slate-50"
          >
            Download PDF
          </a>
        </Card>
      </SignForm>
    </Shell>
  );
}
