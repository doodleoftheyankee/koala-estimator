// The quote-level rules, written from the accuracy audit (Nov 2026) and the owner's decisions:
//
//  - same_price_text (audit S1-F1, OD1, OD4): an option's price reads the same on every surface that
//    shows it, in whole dollars ("$4,322", never "$4,321.50" or "$4,321.5"), and every headline
//    (lists, cards) is the recommended option's price.
//  - valid_until_is_expiry (audit S1-F8, OD11): the "Valid until" date printed on a quote is the
//    business-zone date of the last moment its link works.
//
// PRICE_SURFACES lists every place a price is read, the file and line that prints it and how the
// check reads it: "rendered" surfaces are rendered for real here (the signing page, the emails);
// "formatter" surfaces call the same formatter the file calls (the PDF, the jobs pages). A test
// (lib/accuracy/invariants.test.ts) fails when a listed snippet is no longer in its file, so the
// list cannot quietly go stale: when a surface changes, change its entry and priceTexts with it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SignForm } from '@/app/q/[token]/SignForm';
import { SignedSummary } from '@/app/q/[token]/parts';
import { longDate, monthlyFigure, priceExact, tierName, type QuoteOptionView } from '@/app/q/[token]/quote-view';
import { businessDate, formatDateLong, formatMoney } from '@/lib/format';
import { recommendedTier } from '@/lib/field/recommended';
import { headlinePrice } from '@/lib/office/estimates';
import type { EstimateInput, PricedEstimate, PricingBundle, Tier } from '@/lib/pricing';
import { dollarsText, type Violation } from '@/lib/pricing/invariants';
import type { EstimateDraft } from '@/lib/sync/draft';
import { buildSyncPayload } from '@/lib/sync/payload';
import { financingLine, officeSignedNotice, optionName, quoteEmail, signedConfirmationEmail } from './email';
import { buildQuoteDocument, formatUsd, type QuoteDocument } from './model';
import { quoteSettingsFromRows } from './settings';

export interface PriceSurface {
  label: string;
  /** Who reads it. */
  audience: 'customer' | 'office' | 'estimator';
  /** option: each option's price; headline: one price per estimate (OD1); signed: the price an option was signed for. */
  reads: 'option' | 'headline' | 'signed';
  /** Where it is printed (line as of the accuracy baseline; the snippet is what the test looks for). */
  file: string;
  line: number;
  snippet: string;
  how: 'rendered' | 'formatter';
}

export const PRICE_SURFACES = {
  quote_page: {
    label: 'quote page (chosen option and its total)',
    audience: 'customer',
    reads: 'option',
    file: 'app/q/[token]/SignForm.tsx',
    line: 230,
    snippet: '{price(option.price)}',
    how: 'rendered',
  },
  sign_button: {
    label: 'sign button',
    audience: 'customer',
    reads: 'option',
    file: 'app/q/[token]/SignForm.tsx',
    line: 515,
    snippet: '`Sign and accept ${price(selected.price)}`',
    how: 'rendered',
  },
  accept_sentence: {
    label: 'accept sentence ("You are accepting … for …")',
    audience: 'customer',
    reads: 'option',
    file: 'app/q/[token]/SignForm.tsx',
    line: 483,
    snippet: '{priceExact(selected.price)}</strong>.',
    how: 'rendered',
  },
  signed_page: {
    label: 'signed page ("You accepted … for …" and the signed price)',
    audience: 'customer',
    reads: 'signed',
    file: 'app/q/[token]/SignForm.tsx',
    line: 441,
    snippet: 'for {priceExact(selected.price)}.',
    how: 'rendered',
  },
  pdf: {
    label: 'quote PDF option total',
    audience: 'customer',
    reads: 'option',
    file: 'lib/quotes/pdf.tsx',
    line: 109,
    snippet: '{formatUsd(option.price)}',
    how: 'formatter',
  },
  signed_pdf: {
    label: 'signed PDF price',
    audience: 'customer',
    reads: 'signed',
    file: 'lib/quotes/pdf.tsx',
    line: 193,
    snippet: '{formatUsd(signature.price, true)}',
    how: 'formatter',
  },
  quote_email: {
    label: 'quote email',
    audience: 'customer',
    reads: 'option',
    file: 'lib/quotes/email.ts',
    line: 137,
    snippet: 'formatUsd(o.price)',
    how: 'rendered',
  },
  signed_email: {
    label: 'signed confirmation email',
    audience: 'customer',
    reads: 'signed',
    file: 'lib/quotes/email.ts',
    line: 174,
    snippet: 'Price: <strong>${escapeHtml(formatUsd(price, true))}</strong><br>Property',
    how: 'rendered',
  },
  office_email: {
    label: 'office "quote signed" email',
    audience: 'office',
    reads: 'signed',
    file: 'lib/quotes/email.ts',
    line: 196,
    snippet: '`Quote signed: ${doc.customer.name} - ${formatUsd(price)} (${doc.quoteNumber})`',
    how: 'rendered',
  },
  jobs_list: {
    label: 'jobs list signed price',
    audience: 'office',
    reads: 'signed',
    file: 'app/jobs/page.tsx',
    line: 335,
    snippet: '{formatMoney(price)}',
    how: 'formatter',
  },
  job_page: {
    label: 'job page option price',
    audience: 'office',
    reads: 'signed',
    file: 'app/jobs/[id]/page.tsx',
    line: 112,
    snippet: '{formatMoney(option.price)}',
    how: 'formatter',
  },
  office_list: {
    label: 'office estimates list headline',
    audience: 'office',
    reads: 'headline',
    file: 'app/estimates/page.tsx',
    line: 404,
    snippet: '{formatMoney(price)}',
    how: 'formatter',
  },
  field_card: {
    label: "estimator's phone list headline",
    audience: 'estimator',
    reads: 'headline',
    file: 'app/field/EstimateList.tsx',
    line: 303,
    snippet: '{formatMoney(row.price, { cents: \'never\' })}',
    how: 'formatter',
  },
} as const satisfies Record<string, PriceSurface>;
export type SurfaceId = keyof typeof PRICE_SURFACES;
export const SURFACE_IDS = Object.keys(PRICE_SURFACES) as SurfaceId[];

// ---------------------------------------------------------------------------
// Reading a price out of a rendered surface
// ---------------------------------------------------------------------------

const MONEY = /-?\$\d[\d,]*(?:\.\d+)?/;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&middot;': '·', '&nbsp;': ' ' };

/** Text as a person reads it: tags out, entities decoded, spaces collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[#\w]+;/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first amount after `anchor` in `text`, or a marker that it was not found. */
function moneyAfter(text: string, anchor: string, from = 0): string {
  const at = text.indexOf(anchor, from);
  if (at < 0) return `(no "${anchor}")`;
  const m = MONEY.exec(text.slice(at + anchor.length));
  return m ? m[0] : `(no amount after "${anchor}")`;
}

function pageOptions(doc: QuoteDocument): QuoteOptionView[] {
  // As app/q/[token]/page.tsx builds them.
  return doc.options.map((o) => ({
    tier: o.tier,
    label: o.label,
    bullets: o.bullets,
    items: o.items,
    price: o.price,
    financing: o.financing ? { monthly: monthlyFigure(o.financing), termMonths: o.financing.termMonths, line: financingLine(o.financing) } : null,
  }));
}

/** The customer's signing page with `tier` chosen, as text. */
function signingPageText(doc: QuoteDocument, tier: Tier): string {
  return plainText(
    renderToStaticMarkup(
      createElement(SignForm, {
        token: 'x'.repeat(43),
        options: pageOptions(doc),
        recommendedTier: doc.recommendedTier,
        defaultTier: tier,
        pdfHref: '/quote.pdf',
        quoteNumber: doc.quoteNumber,
        validUntil: doc.validUntil,
        intro: null,
        contacts: null,
      }),
    ),
  );
}

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * How each surface prints `tier`'s price (every reading, when a surface prints it more than once),
 * for the per-option and signed surfaces. Headline surfaces are in headlineTexts.
 */
export function priceTexts(doc: QuoteDocument, tier: Tier): Partial<Record<SurfaceId, string[]>> {
  const option = doc.options.find((o) => o.tier === tier);
  if (!option) return {};
  const page = signingPageText(doc, tier);
  const covers = page.indexOf('What the price covers');
  const quoteMail = quoteEmail(doc, 'https://example.com/q/x');
  const anchor = optionName(doc, tier);
  const signedMail = signedConfirmationEmail(doc, tier, option.price, 'https://example.com/signed.pdf');
  const officeMail = officeSignedNotice(doc, tier, option.price, '00000000-0000-4000-8000-000000000000');
  const subjectMoney = officeMail.subject.match(new RegExp(MONEY.source, 'g')) ?? ['(no amount in the subject)'];
  const signedSummary = plainText(renderToStaticMarkup(createElement(SignedSummary, { tier, label: option.label, price: option.price })));
  return {
    quote_page: uniq([
      moneyAfter(page, `${tierName(tier)} · Your choice`),
      ...(option.items.length ? [covers < 0 ? '(no "What the price covers")' : moneyAfter(page, 'Total', covers)] : []),
    ]),
    sign_button: [moneyAfter(page, 'Sign and accept')],
    accept_sentence: [moneyAfter(page, 'You are accepting')],
    // The thank-you sentence is shown only after signing (component state), so it is read with
    // the formatter it calls; the signed summary beside it is rendered.
    signed_page: uniq([priceExact(option.price), MONEY.exec(signedSummary)?.[0] ?? '(no amount in the signed summary)']),
    pdf: [formatUsd(option.price)],
    signed_pdf: [formatUsd(option.price, true)],
    quote_email: uniq([moneyAfter(plainText(quoteMail.html), anchor), moneyAfter(quoteMail.text, `- ${anchor}: `)]),
    signed_email: uniq([moneyAfter(plainText(signedMail.html), 'Price:'), moneyAfter(signedMail.text, 'Price:')]),
    office_email: uniq([...subjectMoney, moneyAfter(plainText(officeMail.html), 'Price:'), moneyAfter(officeMail.text, 'Price:')]),
    jobs_list: [formatMoney(option.price)],
    job_page: [formatMoney(option.price)],
  };
}

/** What a headline reads from: the estimate as the server stores it after a sync. */
export interface HeadlineInput {
  selectedTier: Tier | null;
  /** The options stored for the estimate (the ones shown), with their prices. */
  options: ReadonlyArray<{ tier: Tier; price: number }>;
  /** estimates.model_total_price as the sync stores it. */
  modelTotalPrice: number | null;
  signedPrice: number | null;
}

/** The headline as the server stores it, from the phone's draft and prices (lib/sync/payload.ts, for real). */
export function headlineInputFor(draft: EstimateDraft, priced: PricedEstimate, bundle: PricingBundle): HeadlineInput {
  let n = 0;
  const p = buildSyncPayload(draft, priced, bundle, { pricedOffline: false, uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` });
  return {
    selectedTier: (p.estimate.selected_tier as Tier | null) ?? null,
    options: p.options.map((o) => ({ tier: o.tier as Tier, price: Number(o.price) })),
    modelTotalPrice: typeof p.estimate.model_total_price === 'number' ? p.estimate.model_total_price : null,
    signedPrice: null,
  };
}

/**
 * The headline every list should show (OD1): the recommended option's price, recommended being
 * the option the estimator picked, else Better, else the first option (lib/field/recommended.ts).
 */
export function expectedHeadline(h: HeadlineInput): { tier: Tier; price: number } | null {
  if (h.signedPrice !== null) {
    const tier = h.options.find((o) => o.tier === h.selectedTier)?.tier ?? h.selectedTier ?? 'better';
    return { tier, price: h.signedPrice };
  }
  const rec = recommendedTier(h.options, h.selectedTier);
  const o = rec ? h.options.find((x) => x.tier === rec.tier) : undefined;
  return o ? { tier: o.tier, price: o.price } : null;
}

/** How each headline surface prints the estimate's headline today. */
export function headlineTexts(h: HeadlineInput): Partial<Record<SurfaceId, string[]>> {
  const office = headlinePrice({ selectedTier: h.selectedTier, options: h.options, modelTotalPrice: h.modelTotalPrice, signedPrice: h.signedPrice });
  // The phone saves the recommended option's price with the draft (app/field/EstimateEditor.tsx summary).
  const rec = recommendedTier(h.options, h.selectedTier);
  const phone = rec ? h.options.find((o) => o.tier === rec.tier)?.price ?? null : null;
  return {
    office_list: [office.price === null ? '(not priced)' : formatMoney(office.price)],
    field_card: [phone === null ? '(not priced)' : formatMoney(phone, { cents: 'never' })],
  };
}

/**
 * The surfaces whose reading differs from `want` (the price in whole dollars): one violation per
 * surface, the kind being the surface. `what` says what the price is, for the detail.
 */
export function compareReadings(tier: Tier | null, want: string, readings: Partial<Record<SurfaceId, string[]>>, what = want): Violation[] {
  const out: Violation[] = [];
  for (const id of SURFACE_IDS) {
    const bad = (readings[id] ?? []).filter((t) => t !== want);
    if (bad.length) {
      out.push({
        invariant: 'same_price_text',
        kind: id,
        tier,
        areaId: null,
        detail: `${PRICE_SURFACES[id].label} reads ${bad.map((t) => `"${t}"`).join(' and ')} for ${what}`,
      });
    }
  }
  return out;
}

/**
 * same_price_text: one violation per option and surface whose reading differs from the option's
 * price in whole dollars, plus one per headline surface whose reading differs from the recommended
 * option's price (only when `headline` is given). The kind is the surface.
 */
export function checkSamePriceText(doc: QuoteDocument, headline?: HeadlineInput): Violation[] {
  const out = doc.options.flatMap((o) => compareReadings(o.tier, dollarsText(o.price), priceTexts(doc, o.tier)));
  const want = headline ? expectedHeadline(headline) : null;
  if (headline && want) {
    out.push(...compareReadings(want.tier, dollarsText(want.price), headlineTexts(headline), `${dollarsText(want.price)}, the recommended option (${want.tier})`));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Valid until
// ---------------------------------------------------------------------------

/**
 * When a quote's link stops working: issued + validDays x 24 h, as app/api/quotes/route.ts:159
 * stores expires_at; the link works up to and including that moment (lib/quotes/lookup.ts isExpired).
 */
export function linkExpiresAt(issuedAt: Date | string, validDays: number): Date {
  return new Date(new Date(issuedAt).getTime() + validDays * 86_400_000);
}

const DAY = 86_400_000;
const dayNumber = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`) / DAY;

/**
 * valid_until_is_expiry: the date the quote prints after "Valid until" (the signing page and the
 * quote email, rendered) is the business-zone date of the last moment the link works. One
 * violation per quote; the kind says which way it is off (day_after, day_before, days_off).
 */
export function checkValidUntilIsExpiry(doc: QuoteDocument, expiresAt: Date | string): Violation[] {
  const want = formatDateLong(expiresAt);
  const page = longDate(doc.validUntil);
  const mail = /valid until ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(quoteEmail(doc, 'https://example.com/q/x').text)?.[1] ?? '(not found)';
  if (page === want && mail === want) return [];
  const printedDay = businessDate(doc.validUntil.length === 10 ? `${doc.validUntil}T12:00:00Z` : doc.validUntil);
  const lastDay = businessDate(expiresAt);
  const diff = printedDay && lastDay ? dayNumber(printedDay) - dayNumber(lastDay) : NaN;
  const kind = page === want ? 'email_differs' : diff === 1 ? 'day_after' : diff === -1 ? 'day_before' : 'days_off';
  return [
    {
      invariant: 'valid_until_is_expiry',
      kind,
      tier: null,
      areaId: null,
      detail: `prints "Valid until ${page}" (email: ${mail}); the link works until ${want} (${new Date(expiresAt).toISOString()})`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Building a quote the way the app does, for the checks
// ---------------------------------------------------------------------------

/** A draft around a pricing input, with neutral sample contact details (no real person). */
export function sampleDraft(args: { id: string; input: EstimateInput; selectedTier: Tier | null; createdAt: string }): EstimateDraft {
  const { id, input } = args;
  return {
    id,
    status: 'ready',
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
    customer: { id, firstName: 'Sample', lastName: 'Customer', email: 'customer@example.com', phone: null, smsConsent: false, emailConsent: true },
    property: { id, street: '1 Sample Street', city: 'Sampletown', state: 'ST', zip: '00000', yearBuilt: null, utility: null, homeType: null },
    areas: input.areas,
    crewId: input.crewId,
    driveMinutesOneWay: input.driveMinutesOneWay,
    overrides: input.overrides,
    lineOverrides: input.lineOverrides ?? {},
    deviationAcks: {},
    measurements: {},
    photoReads: {},
    selectedTier: args.selectedTier,
    notes: '',
    rowVersion: null,
    bundleHash: null,
    lastQuote: null,
  };
}

/** The quote document the send route would build for this draft and these options (lib/quotes/model.ts, for real). */
export function sampleQuote(draft: EstimateDraft, priced: PricedEstimate, issuedAt: Date | string, validDays: number): QuoteDocument {
  const settings = quoteSettingsFromRows([]);
  return buildQuoteDocument({
    draft,
    options: priced.options,
    version: 1,
    issuedAt: new Date(issuedAt),
    validDays,
    branding: settings.branding,
    estimator: { name: 'Sample Estimator', email: null },
    terms: settings.terms,
    warranty: settings.warranty,
  });
}

/** Both quote-level rules on one quote. */
export function checkQuote(doc: QuoteDocument, expiresAt: Date | string, headline?: HeadlineInput): Violation[] {
  return [...checkSamePriceText(doc, headline), ...checkValidUntilIsExpiry(doc, expiresAt)];
}

