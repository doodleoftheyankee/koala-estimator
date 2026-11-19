// The customer's quote page: review options, download the PDF, and e-sign.
// Public (no session). Renders only snapshot.document, which never contains costs.
// The franchise header comes from the layout, so every state below (and the not-found and error
// pages) sits under the same header.
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CircleCheck, Clock, Files, Lock } from '@/components/daymark/icons';
import { consentFor } from '@/lib/quotes/consent';
import { financingLine } from '@/lib/quotes/email';
import { isExpired, type PublicQuoteRow } from '@/lib/quotes/lookup';
import { documentTimeZone, isLegacyDocument } from '@/lib/quotes/model';
import { createAdminClient } from '@/lib/supabase/admin';
import { getQuote } from './data';
import { ClosedState, ContactCard, NotesCard, OfficeContact, PdfLink, QuoteIntro, ReachUsAction, SignedSummary, TermsCard } from './parts';
import { expiredOn, longDate, monthlyFigure, type QuoteOptionView } from './quote-view';
import { SignForm } from './SignForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: { absolute: 'Your insulation quote' },
  robots: { index: false, follow: false },
};

const VIEW_DEDUPE_MS = 30 * 60 * 1000;

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

export default async function QuotePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const quote = await getQuote(token);
  if (!quote) notFound();
  const doc = quote.document;
  const pdfHref = `/api/public/quotes/${token}/pdf`;
  const contacts = <ContactCard estimator={doc.estimator} branding={doc.branding} />;
  const reachUs = <ReachUsAction branding={doc.branding} estimator={doc.estimator} />;
  // A quote sent before the accuracy round reads its sentences with cents, as it always did (hard rule 1).
  const legacy = isLegacyDocument(doc);

  if (quote.status === 'signed') {
    const opt = quote.signed_tier ? doc.options.find((o) => o.tier === quote.signed_tier) : undefined;
    const signedPrice = quote.signed_price !== null ? Number(quote.signed_price) : (opt?.price ?? null);
    return (
      <ClosedState
        quoteNumber={doc.quoteNumber}
        icon={CircleCheck}
        tone="ok"
        title={`Thank you${quote.signer_name ? `, ${quote.signer_name}` : ''}!`}
        action={<PdfLink href={pdfHref}>Download your signed quote (PDF)</PdfLink>}
        aside={contacts}
      >
        <p>Your quote was signed{quote.signed_at ? ` on ${longDate(quote.signed_at, documentTimeZone(doc))}` : ''}.</p>
        {quote.signed_tier ? <SignedSummary tier={quote.signed_tier} label={opt?.label ?? null} price={signedPrice} cents={legacy} /> : null}
        <p>
          We will contact you shortly to schedule the work. Questions? <OfficeContact branding={doc.branding} estimator={doc.estimator} capital />.
        </p>
      </ClosedState>
    );
  }

  if (quote.status === 'superseded') {
    return (
      <ClosedState quoteNumber={doc.quoteNumber} icon={Files} tone="info" title="There’s a newer version of this quote" action={reachUs} aside={contacts}>
        <p>
          A newer version of this quote was sent to you. Please use the link in the most recent email, or <OfficeContact branding={doc.branding} estimator={doc.estimator} />.
        </p>
      </ClosedState>
    );
  }

  if (quote.status === 'declined') {
    return (
      <ClosedState quoteNumber={doc.quoteNumber} icon={Lock} title="This quote is no longer open" action={reachUs} aside={contacts}>
        <p>
          If you would like an updated quote, <OfficeContact branding={doc.branding} estimator={doc.estimator} />.
        </p>
      </ClosedState>
    );
  }

  if (quote.status === 'expired' || isExpired(quote)) {
    return (
      <ClosedState quoteNumber={doc.quoteNumber} icon={Clock} tone="warn" title="This quote has expired" action={reachUs} aside={contacts}>
        <p>
          This quote expired on {expiredOn(doc, quote.expires_at)}. Prices may have changed; for an updated quote, <OfficeContact branding={doc.branding} estimator={doc.estimator} />.
        </p>
      </ClosedState>
    );
  }

  await recordView(createAdminClient(), quote);

  const options: QuoteOptionView[] = doc.options.map((o) => ({
    tier: o.tier,
    label: o.label,
    bullets: o.bullets,
    items: o.items,
    price: o.price,
    financing: o.financing ? { monthly: monthlyFigure(o.financing), termMonths: o.financing.termMonths, line: financingLine(o.financing) } : null,
  }));
  const defaultTier = doc.recommendedTier && options.some((o) => o.tier === doc.recommendedTier) ? doc.recommendedTier : (options[0]?.tier ?? null);

  return (
    <SignForm
      token={token}
      options={options}
      recommendedTier={doc.recommendedTier}
      defaultTier={defaultTier}
      pdfHref={pdfHref}
      quoteNumber={doc.quoteNumber}
      validUntil={doc.validUntil}
      consentText={consentFor(doc)}
      centsInSentences={legacy}
      intro={<QuoteIntro doc={doc} />}
      contacts={contacts}
      contactsAside={<ContactCard estimator={doc.estimator} branding={doc.branding} headingId="contact-heading-aside" />}
    >
      {doc.notes ? <NotesCard notes={doc.notes} /> : null}
      <TermsCard doc={doc} pdfHref={pdfHref} />
    </SignForm>
  );
}
