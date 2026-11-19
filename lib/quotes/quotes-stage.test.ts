// The quotes stage of the accuracy round (docs/accuracy/ledger.txt, stage "quotes"): one test per
// value change, each shown failing on the code before the stage and passing after. Functions and
// modules the stage adds are imported inside their tests, so this file also runs on the code
// before the stage (where those tests fail) instead of failing to load.
//
//  L8   whole dollars in the accept sentence, the thank-you page, the signed PDF and signed emails
//  L9   the headline is the recommended option everywhere; a pick that is gone gives the next one
//  L12  quote numbers from a counter, the year in the business time zone
//  L13  "Valid until" is the business-zone date of the last moment the link works
//  L30  no quote goes out while the business profile has a gap
//  L31  new quotes' consent sentence names the profile's state
//  L32  new estimates start in the profile's town, else the shop address's, else blank
//  L33  honest wording when email is not set up, and on the PDF
//  L39  each option block on the PDF stays on one page
// Hard rule 1 runs through all of it: a quote sent before the stage prints exactly as it did.
import { inflateSync } from 'node:zlib';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { priceEstimate, type Tier } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { recommendedTier } from '@/lib/field/recommended';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { officeSignedNotice, signedConfirmationEmail } from './email';
import { buildQuoteDocument, type Branding, type QuoteDocument } from './model';
import { renderQuotePdf } from './pdf';

vi.mock('server-only', () => ({}));

const BRAND: Branding = {
  company: 'Acme Attics of Springfield',
  license: 'HIC 77-0042',
  phone: '(555) 010-0199',
  email: 'office@acme.example',
  website: null,
  primaryColor: '#7c3aed',
  logoUrl: null,
};
const SPRINGFIELD = { city: 'Springfield', state: 'IL' };
const CONSENT_IL =
  'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and Illinois UETA). I accept the option and price I selected above and the terms of this quote.';

/** A quote as the send route builds it, sent at `issuedAt`, with Better at `betterPrice`. */
function makeDoc(opts: { issuedAt?: string; betterPrice?: number; selectedTier?: Tier | null } = {}): QuoteDocument {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'), undefined, SPRINGFIELD);
  d.customer = { ...d.customer, firstName: 'Robin', lastName: 'Vale', email: 'robin@example.com' };
  d.property = { ...d.property, street: '9 Elm Ct', city: 'Springfield', state: 'IL', zip: '62701' };
  d.areas = [{ ...newArea('attic'), sqft: 1000, currentR: 19 }];
  d.selectedTier = opts.selectedTier ?? null;
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  const doc = buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 1,
    quoteNumber: 'AA-2026-0001-v1',
    issuedAt: new Date(opts.issuedAt ?? '2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: BRAND,
    estimator: { name: 'Sam Rivera', email: 'sam@acme.example' },
    terms: 'Terms as the franchise wrote them.',
    warranty: 'Warranty as the franchise wrote it.',
    consent: CONSENT_IL,
  });
  if (opts.betterPrice === undefined) return doc;
  // One option at a round price, its one line adding up to it (as the engine's lines do).
  return {
    ...doc,
    options: doc.options.map((o) => (o.tier === 'better' ? { ...o, price: opts.betterPrice!, items: [{ kind: 'work' as const, areaName: 'Attic', description: 'Air sealing and cellulose', price: opts.betterPrice! }] } : o)),
  };
}

/** The same document as one sent before the stage: no format and no consent of its own. */
function sentBefore(doc: QuoteDocument): QuoteDocument {
  const copy: Partial<QuoteDocument> = { ...doc };
  delete copy.format;
  delete copy.consent;
  return copy as QuoteDocument;
}

const text = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------
// The PDF as text, page by page: each page's content stream inflated, its text runs decoded and
// joined.
// ---------------------------------------------------------------------------
function pdfPages(pdf: Buffer): string[] {
  const pages: string[] = [];
  const raw = pdf.toString('latin1');
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    let body: string;
    try {
      body = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    const runs = [...body.matchAll(/\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ|<([0-9a-fA-F]*)>\s*Tj/g)].map((r) =>
      [...(r[1] ?? `<${r[2]}>`).matchAll(/<([0-9a-fA-F]*)>/g)].map((h) => Buffer.from(h[1]!, 'hex').toString('latin1')).join(''),
    );
    // One run per piece of text the page draws (a title's tier and label are separate pieces).
    if (runs.length) pages.push(runs.join(''));
    re.lastIndex = end;
  }
  return pages;
}

const SIGNATURE = (tier: Tier, price: number) => ({
  signerName: 'Robin Vale',
  signedAt: '2026-11-18T19:41:07.000Z',
  tier,
  price,
  imagePng: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
  ip: '203.0.113.7',
});

describe('L8: one price, whole dollars, in every sentence (S1-F1, OD4)', () => {
  it('the thank-you page says "for $4,780", not "for $4,780.00"', async () => {
    const { SignedThanks } = (await import('@/app/q/[token]/SignForm')) as Record<string, unknown>;
    expect(SignedThanks, 'the thank-you page is its own component').toBeTypeOf('function');
    const doc = makeDoc({ betterPrice: 4780 });
    const better = doc.options.find((o) => o.tier === 'better')!;
    const props = { quoteNumber: doc.quoteNumber, name: 'Robin Vale', option: better, emailed: true, pdfHref: '/pdf', contacts: null };
    const out = text(createElement(SignedThanks as (p: Record<string, unknown>) => ReactElement, { ...props, centsInSentences: false }));
    expect(out).toContain('for $4,780.');
    expect(out).not.toContain('$4,780.00');
    // A quote sent before the stage keeps its cents there (hard rule 1).
    expect(text(createElement(SignedThanks as (p: Record<string, unknown>) => ReactElement, { ...props, centsInSentences: true }))).toContain('for $4,780.00.');
  });

  it('the signed PDF says "Price: $4,780"; a quote sent before still says "$4,780.00"', async () => {
    const doc = makeDoc({ betterPrice: 4780 });
    const signed = pdfPages(await renderQuotePdf(doc, SIGNATURE('better', 4780))).join('\n');
    expect(signed).toContain('Price: $4,780');
    expect(signed).not.toContain('$4,780.00');
    const old = pdfPages(await renderQuotePdf(sentBefore(doc), SIGNATURE('better', 4780))).join('\n');
    expect(old).toContain('Price: $4,780.00');
  });

  it('the signed emails say "Price: $4,780", the office email\'s subject and body alike', () => {
    const doc = makeDoc({ betterPrice: 4780 });
    const mail = signedConfirmationEmail(doc, 'better', 4780, 'https://app.example.com/pdf');
    expect(mail.text).toContain('Price: $4,780\n');
    expect(mail.html).toContain('Price: <strong>$4,780</strong>');
    const office = officeSignedNotice(doc, 'better', 4780, '00000000-0000-4000-8000-000000000001');
    expect(office.subject).toContain('$4,780 (');
    expect(office.text).toContain('Price: $4,780\n');
    expect(signedConfirmationEmail(sentBefore(doc), 'better', 4780).text).toContain('Price: $4,780.00\n');
  });
});

describe('L9: the headline is the recommended option everywhere (OD1, S2-F12, R5)', () => {
  it('a picked option that is not shown recommends the next one shown', () => {
    // Better hidden (OD6: Best does more for the same price): the pick moves up to Best, not down to Good.
    expect(recommendedTier([{ tier: 'good' }, { tier: 'best' }], 'better')).toEqual({ tier: 'best', picked: false });
    expect(recommendedTier([{ tier: 'better' }, { tier: 'best' }], 'good')).toEqual({ tier: 'better', picked: false });
    // Nothing after it: the nearest one before.
    expect(recommendedTier([{ tier: 'good' }, { tier: 'better' }], 'best')).toEqual({ tier: 'better', picked: false });
  });

  it('the quote recommends the same option as the lists', () => {
    const doc = makeDoc({ selectedTier: 'better' });
    const shown = doc.options.filter((o) => o.tier !== 'better');
    const d = newDraft(new Date('2026-10-20T12:00:00Z'), undefined, SPRINGFIELD);
    d.areas = [{ ...newArea('attic'), sqft: 1000, currentR: 19 }];
    d.selectedTier = 'better';
    const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
    const options = priced.options.filter((o) => shown.some((s) => s.tier === o.tier));
    const q = buildQuoteDocument({ ...docArgs(d), options });
    expect(q.recommendedTier).toBe('best');
  });
});

function docArgs(d: ReturnType<typeof newDraft>) {
  return {
    draft: d,
    options: [],
    version: 1,
    quoteNumber: 'AA-2026-0001-v1',
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding: BRAND,
    estimator: { name: 'Sam Rivera', email: null },
    terms: 'T',
    warranty: 'W',
    consent: CONSENT_IL,
  };
}

describe('L12: quote numbers from a counter (OD10, S2-F16, S2-F17)', () => {
  it('PREFIX-YEAR-0001-v1, a new version keeps its number, the year is the business zone\'s', async () => {
    const m = (await import('./model')) as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>;
    expect(m.counterQuoteNumber, 'counterQuoteNumber').toBeTypeOf('function');
    expect(m.counterQuoteNumber!('KN', 2026, 1, 1)).toBe('KN-2026-0001-v1');
    expect(m.counterQuoteNumber!('KN', 2026, 12345, 3)).toBe('KN-2026-12345-v3');
    expect(m.quoteNumberBase!('KN-2026-0001-v2')).toBe('KN-2026-0001');
    // A number sent before the counter keeps its base for the next version.
    expect(m.quoteNumberBase!('KN-2026-1A2B3C-v1')).toBe('KN-2026-1A2B3C');
    expect(m.legacyQuoteNumber!('1a2b3c4d-0000-4000-8000-000000000000', 1, new Date('2026-11-18T12:00:00Z'))).toBe('KN-2026-1A2B3C-v1');
    // Sent Jan 1 2027 at 03:00 UTC: still Dec 31, 2026 in the business zone.
    expect(m.businessYear!(new Date('2027-01-01T03:00:00Z'))).toBe(2026);
    expect(m.businessYear!(new Date('2027-01-01T06:00:00Z'))).toBe(2027);
  });
});

describe('L13: "Valid until" is the last day the link works (S1-F8, OD11, RF-11)', () => {
  it('sent 2026-11-18 at 02:30 UTC for 30 days: valid until Dec 17 (the link stops at 9:30 PM that evening)', () => {
    const doc = makeDoc({ issuedAt: '2026-11-18T02:30:00Z' });
    expect(doc.validUntil).toBe('2026-12-17');
    // Sent at noon, the date is the same either way.
    expect(makeDoc({ issuedAt: '2026-11-18T17:00:00Z' }).validUntil).toBe('2026-12-18');
  });

  it('the expired page says when the link really stopped: "Dec 17, 2026 · 9:30 PM"', async () => {
    const view = (await import('@/app/q/[token]/quote-view')) as Record<string, unknown>;
    expect(view.expiredOn, 'expiredOn').toBeTypeOf('function');
    const expiredOn = view.expiredOn as (doc: QuoteDocument, expiresAt: string) => string;
    const doc = makeDoc({ issuedAt: '2026-11-18T02:30:00Z' });
    expect(expiredOn(doc, '2026-12-18T02:30:00.000Z')).toBe('Dec 17, 2026 · 9:30 PM');
    // A quote sent before says the date it printed, as it did (hard rule 1).
    expect(expiredOn({ ...sentBefore(doc), validUntil: '2026-12-18' }, '2026-12-18T02:30:00.000Z')).toBe('December 18, 2026');
  });
});

describe('L30: no quote goes out while the business profile has a gap (RF-01)', () => {
  // The live seed: a placeholder warranty, no phone, no license, no state.
  const live = [
    { key: 'branding', value: { company: 'A franchise', license: null, phone: null, primary_color: null, logo_path: null } },
    { key: 'quote_terms', value: 'Quote valid for the period shown.' },
    { key: 'warranty_text', value: 'Workmanship warranty — PLACEHOLDER, owner to replace.' },
    { key: 'shop_address', value: 'Springfield, IL 62701' },
    { key: 'quote_number_prefix', value: 'KN' },
  ];

  it('names every gap in one plain sentence; a finished profile has none', async () => {
    const p = (await import('./profile')) as typeof import('./profile');
    const gaps = p.businessProfileGaps(live);
    expect(gaps.map((g) => g.key)).toEqual(['branding.license', 'branding.phone', 'default_state', 'warranty_text']);
    expect(p.profileGapsSentence(gaps)).toBe('The business profile is not finished: add the license number, the office phone, the state and the warranty.');
    const done = [
      ...live.filter((r) => r.key !== 'branding' && r.key !== 'warranty_text'),
      { key: 'branding', value: { company: 'A franchise', license: 'HIC 77-0042', phone: '(555) 010-0199' } },
      { key: 'warranty_text', value: 'Two years on workmanship.' },
      { key: 'default_state', value: 'IL' },
    ];
    expect(p.businessProfileGaps(done)).toEqual([]);
    expect(p.businessProfileGaps([...done, { key: 'default_state', value: 'XX' }].filter((r, i, a) => a.findLastIndex((x) => x.key === r.key) === i)).map((g) => g.key)).toEqual(['default_state']);
    expect(p.businessProfileGaps([...done.filter((r) => r.key !== 'quote_number_prefix'), { key: 'quote_number_prefix', value: 'k-n' }]).map((g) => g.key)).toEqual(['quote_number_prefix']);
  });
});

describe('L31: the consent sentence names the profile\'s state; a quote sent before keeps its own (RF-01, rule 4)', () => {
  it('"(ESIGN Act and Delaware UETA)" -> "(ESIGN Act and <the profile\'s state> UETA)"', async () => {
    const c = (await import('./consent')) as Record<string, unknown>;
    expect(c.esignConsent, 'esignConsent').toBeTypeOf('function');
    const esignConsent = c.esignConsent as (s: string) => string;
    const consentFor = c.consentFor as (d: Partial<QuoteDocument>) => string;
    expect(esignConsent('IL')).toBe(CONSENT_IL);
    expect(esignConsent('pa')).toContain('(ESIGN Act and Pennsylvania UETA)');
    expect(() => esignConsent('XX')).toThrow();
    expect(consentFor(makeDoc())).toBe(CONSENT_IL);
    expect(consentFor(sentBefore(makeDoc()))).toContain('(ESIGN Act and Delaware UETA)');
  });
});

describe('L32: a new estimate starts in the profile\'s town, else the shop address\'s, else blank (RF-17)', () => {
  it('no town is typed into the code', () => {
    const d = newDraft(new Date('2026-11-18T12:00:00Z'));
    expect(d.property.city).toBe('');
    expect(d.property.state).toBe('');
  });

  it('the profile, then the shop address', async () => {
    const p = (await import('./profile')) as typeof import('./profile');
    expect(p.newEstimateDefaults([{ key: 'default_city', value: 'Bear' }, { key: 'default_state', value: 'de' }, { key: 'shop_address', value: 'Springfield, IL 62701' }])).toEqual({ city: 'Bear', state: 'DE' });
    expect(p.newEstimateDefaults([{ key: 'shop_address', value: 'Springfield, IL 62701' }])).toEqual({ city: 'Springfield', state: 'IL' });
    expect(p.newEstimateDefaults([{ key: 'shop_address', value: '12 Main St, Springfield, IL' }])).toEqual({ city: 'Springfield', state: 'IL' });
    expect(p.newEstimateDefaults([])).toEqual({ city: '', state: '' });
    expect(newDraft(new Date(), undefined, { city: 'Bear', state: 'DE' }).property).toMatchObject({ city: 'Bear', state: 'DE' });
  });
});

describe('L33: honest wording (RF-12)', () => {
  it('with email not set up, the thank-you page points to the download instead of an email that never went', async () => {
    const { SignedThanks } = (await import('@/app/q/[token]/SignForm')) as Record<string, unknown>;
    expect(SignedThanks).toBeTypeOf('function');
    const doc = makeDoc();
    const option = doc.options[0]!;
    const props = { quoteNumber: doc.quoteNumber, name: 'Robin Vale', option, centsInSentences: false, pdfHref: '/pdf', contacts: null };
    const off = text(createElement(SignedThanks as (p: Record<string, unknown>) => ReactElement, { ...props, emailed: false }));
    expect(off).toContain('Download your signed copy below.');
    expect(off).not.toContain('emailed');
    expect(text(createElement(SignedThanks as (p: Record<string, unknown>) => ReactElement, { ...props, emailed: true }))).toContain('We emailed you a copy');
  });

  it('the PDF says "Sign online at the link we sent you." (the link may not have come by email)', async () => {
    const doc = makeDoc();
    expect(pdfPages(await renderQuotePdf(doc)).join('\n')).toContain('Sign online at the link we sent you.');
    // The PDF of a quote sent before is the stored file; rendered again, it reads as it did.
    expect(pdfPages(await renderQuotePdf(sentBefore(doc))).join('\n')).toContain('Sign online at the link in your email.');
  });
});

describe('L39: each option block on the PDF stays on one page (UX-01)', () => {
  it('no option starts on one page and ends on the next', async () => {
    // Three options, each with a few more lines than the last, so that at some length an option
    // reaches the bottom of page 1.
    const base = makeDoc();
    const withLines = (doc: QuoteDocument, n: number): QuoteDocument => ({
      ...doc,
      options: doc.options.map((o, i) => ({
        ...o,
        bullets: ['One', 'Two', 'Three'],
        items: Array.from({ length: n + i }, (_, k) => ({ kind: 'work' as const, areaName: 'Attic', description: `Line ${k + 1} of the work in this area, described in full`, price: 100 })),
        price: (n + i) * 100,
      })),
    });
    const NAMES = { good: 'Good', better: 'Better', best: 'Best' } as const;
    const pageOf = (pages: string[], needle: string) => pages.findIndex((p) => p.includes(needle));
    const split = (pages: string[], doc: QuoteDocument) =>
      doc.options.filter((o) => pageOf(pages, `${NAMES[o.tier]}: ${o.label}`) !== pageOf(pages, `${NAMES[o.tier]} total:`)).map((o) => o.tier);
    let splitBefore = 0;
    for (let n = 2; n <= 9; n++) {
      const doc = withLines(base, n);
      expect(split(pdfPages(await renderQuotePdf(doc)), doc), `${n} lines and up: every option on one page`).toEqual([]);
      // The same quote sent before the stage lays out as it did (hard rule 1), where an option could split.
      if (split(pdfPages(await renderQuotePdf(sentBefore(doc))), doc).length) splitBefore++;
    }
    expect(splitBefore, 'the lengths tried include ones where an option used to split').toBeGreaterThan(0);
  });
});
