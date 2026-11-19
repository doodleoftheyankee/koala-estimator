// Owner decisions OD12-OD14 (docs/accuracy/spec/owner-decisions-2.txt) on every quote document, with
// review A's DOC-1, DOC-2 and DOC-3 and review B's database-B3 / flow-B1: there is no business form
// to fill in, so nothing blocks a send; quotes name "Koala Insulation"; the warranty reads "Limited
// lifetime warranty"; a detail nobody entered is left off; the consent sentence never needs a state
// in the settings; a new estimate's town and state come as a pair. One test per change, each failing
// on the code before it (docs/accuracy/ledger.txt, "Review B fixes and owner decisions OD12-OD16").
import fs from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ContactCard, Masthead, QuoteIntro, TermsCard } from '@/app/q/[token]/parts';
import { monthlyFigure, type QuoteOptionView } from '@/app/q/[token]/quote-view';
import { SignForm } from '@/app/q/[token]/SignForm';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { consentFor, esignConsent } from './consent';
import { financingLine, quoteEmail, signedConfirmationEmail } from './email';
import { buildQuoteDocument, counterQuoteNumber, isLegacyDocument, type QuoteDocument } from './model';
import { renderQuotePdf } from './pdf';
import * as profile from './profile';
import { DEFAULT_COMPANY, DEFAULT_TERMS, DEFAULT_WARRANTY, quoteSettingsFromRows } from './settings';
import seeded from './__fixtures__/seeded-quote-settings.json';

vi.mock('server-only', () => ({}));

type Row = { key: string; value: unknown };

/** The rows a quote is built from, exactly as every migration leaves them (scripts/accuracy/seeded-quote-settings.sh). */
const SEEDED: Row[] = seeded.rows.map((r) => ({ key: r.key, value: r.value }));

/**
 * Production's rows today, read with a SELECT on 2026-11-19, before the migration's OD12/OD13 step:
 * the seeds, with no default_state, no license and no phone.
 */
const LIVE_BEFORE: Row[] = [
  { key: 'branding', value: { phone: null, company: 'Koala Insulation of Newark', license: null, logo_path: null, primary_color: null } },
  {
    key: 'quote_terms',
    value:
      'Quote valid for the period shown. A signed quote authorizes Koala Insulation of Newark to schedule the work. Final price may change only if hidden conditions are found; any change requires your written approval.',
  },
  { key: 'quote_valid_days', value: 30 },
  { key: 'shop_address', value: 'Newark, DE 19711' },
  { key: 'warranty_text', value: 'Workmanship warranty — PLACEHOLDER, owner to replace.' },
];

const NEUTRAL_CONSENT =
  'I agree to sign this quote electronically. My electronic signature is the legal equivalent of my handwritten signature (ESIGN Act and the Uniform Electronic Transactions Act). I accept the option and price I selected above and the terms of this quote.';

function draftIn(place: { city: string; state: string }): EstimateDraft {
  const d = newDraft(new Date('2026-11-19T15:00:00Z'), undefined, place);
  d.customer = { ...d.customer, firstName: 'Robin', lastName: 'Vale', email: 'robin@example.com' };
  d.property = { ...d.property, street: '9 Elm Ct', zip: '62701' };
  d.areas = [{ ...newArea('attic'), sqft: 1000, currentR: 19 }];
  return d;
}

/** A quote built from these settings exactly as the send route builds it (app/api/quotes/route.ts). */
function sendDoc(rows: Row[], place = { city: 'Springfield', state: 'IL' }): QuoteDocument {
  const draft = draftIn(place);
  const priced = priceEstimate(toEstimateInput(draft), snapshot, coefficients);
  const send = profile.quoteSettingsForSend(rows, draft.property.state);
  return buildQuoteDocument({
    draft,
    options: priced.options,
    version: 1,
    quoteNumber: counterQuoteNumber(send.prefix, 2026, 1, 1),
    issuedAt: new Date('2026-11-19T15:00:00Z'),
    validDays: send.settings.validDays,
    branding: send.settings.branding,
    estimator: { name: 'Sam Rivera', email: 'sam@example.com' },
    terms: send.settings.terms,
    warranty: send.settings.warranty,
    consent: send.consent,
  });
}

/** The text each PDF page draws (as in lib/quotes/quotes-stage.test.ts). */
function pdfText(pdf: Buffer): string {
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
    if (runs.length) pages.push(runs.join(' '));
    re.lastIndex = end;
  }
  return pages.join('\n');
}

const plain = (el: ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

function views(doc: QuoteDocument): QuoteOptionView[] {
  return doc.options.map((o) => ({
    tier: o.tier,
    label: o.label,
    bullets: o.bullets,
    items: o.items,
    price: o.price,
    financing: o.financing ? { monthly: monthlyFigure(o.financing), termMonths: o.financing.termMonths, line: financingLine(o.financing) } : null,
  }));
}

/** What the customer's quote page shows: the masthead, the quote with its signing form, the terms and who to ask. */
function pageText(doc: QuoteDocument): string {
  const form = createElement(SignForm, {
    token: 'x'.repeat(43),
    options: views(doc),
    recommendedTier: doc.recommendedTier,
    defaultTier: doc.recommendedTier,
    pdfHref: '/pdf',
    quoteNumber: doc.quoteNumber,
    validUntil: doc.validUntil,
    consentText: consentFor(doc),
    centsInSentences: isLegacyDocument(doc),
    intro: createElement(QuoteIntro, { doc }),
    contacts: createElement(ContactCard, { estimator: doc.estimator, branding: doc.branding }),
  });
  return [
    plain(createElement(Masthead, { branding: doc.branding })),
    plain(form),
    plain(createElement(TermsCard, { doc, pdfHref: '/pdf' })),
    plain(createElement(ContactCard, { estimator: doc.estimator, branding: doc.branding })),
  ].join('\n');
}

/** Every customer surface of a new quote, as text: the page, the PDF, the quote email and the signed confirmation. */
async function surfaces(doc: QuoteDocument): Promise<Record<string, string>> {
  const mail = quoteEmail(doc, 'https://app.example.com/q/x');
  const signed = signedConfirmationEmail(doc, doc.options[0]!.tier, doc.options[0]!.price, 'https://app.example.com/pdf');
  return {
    page: pageText(doc),
    pdf: pdfText(await renderQuotePdf(doc)),
    email: [mail.subject, mail.text, mail.html].join('\n'),
    signedEmail: [signed.subject, signed.text, signed.html].join('\n'),
  };
}

describe('database-B3 / flow-B1: the documents are safe on the settings every migration leaves (OD12, OD13, OD14)', () => {
  it('the seeded rows hold no state, license or phone, and nothing says PLACEHOLDER or Newark', () => {
    expect(SEEDED.find((r) => r.key === 'default_state')).toBeUndefined();
    expect(SEEDED.find((r) => r.key === 'branding')?.value).toMatchObject({ company: 'Koala Insulation', license: null, phone: null });
    for (const key of ['branding', 'quote_terms', 'warranty_text']) {
      expect(JSON.stringify(SEEDED.find((r) => r.key === key)?.value), key).not.toMatch(/placeholder|newark/i);
    }
  });

  it('a quote, its PDF (real render), its email and its page from those rows: Koala Insulation, Limited lifetime warranty, the consent sentence, nothing left blank', async () => {
    const doc = sendDoc(SEEDED);
    expect(doc.branding.company).toBe('Koala Insulation');
    expect(doc.warranty).toBe('Limited lifetime warranty');
    expect(doc.terms).toBe(DEFAULT_TERMS);
    expect(doc.quoteNumber).toBe('KN-2026-0001-v1');
    expect(doc.consent).toBe(esignConsent('IL'));
    expect(doc.consent).toContain('(ESIGN Act and Illinois UETA)');
    const all = await surfaces(doc);
    for (const [where, text] of Object.entries(all)) {
      expect(text, where).toContain('Koala Insulation');
      expect(text, where).not.toMatch(/placeholder/i);
      expect(text, where).not.toMatch(/Newark|Delaware|\(302\)/);
      // No license and no office phone were entered: no label for either, and no "Call" without a number.
      expect(text, where).not.toMatch(/\bLicen[sc]e\b/);
      expect(text, where).not.toMatch(/\bPhone\b/);
      expect(text, where).not.toMatch(/\bCall\b/);
    }
    expect(all.pdf).toContain('Limited lifetime warranty');
    expect(all.page).toContain('Limited lifetime warranty');
    expect(all.page).toContain(doc.consent!);
    // The customer is pointed to the estimator, who has an email.
    expect(all.page).toContain('sam@example.com');
    expect(all.email).toContain('Contact Sam Rivera at sam@example.com');
  });

  it("production's rows before the migration step (PLACEHOLDER warranty, no state): nothing PLACEHOLDER prints and nothing throws", async () => {
    expect(() => sendDoc(LIVE_BEFORE)).not.toThrow();
    const doc = sendDoc(LIVE_BEFORE);
    expect(doc.warranty).toBe('Limited lifetime warranty');
    // The stored company is used as stored until the migration step replaces the seed.
    expect(doc.branding.company).toBe('Koala Insulation of Newark');
    expect(doc.consent).toContain('(ESIGN Act and Illinois UETA)');
    for (const [where, text] of Object.entries(await surfaces(doc))) {
      expect(text, where).not.toMatch(/placeholder/i);
      expect(text, where).not.toMatch(/\bLicen[sc]e\b|\bCall\b/);
    }
  });
});

describe('OD12/OD13: the code defaults and "PLACEHOLDER" as unset', () => {
  it('defaults: Koala Insulation, terms that name no town, Limited lifetime warranty', () => {
    expect(DEFAULT_COMPANY).toBe('Koala Insulation');
    expect(DEFAULT_WARRANTY).toBe('Limited lifetime warranty');
    expect(DEFAULT_TERMS).toBe(
      'Quote valid for the period shown. A signed quote authorizes Koala Insulation to schedule the work. Final price may change only if hidden conditions are found; any change requires your written approval.',
    );
    const s = quoteSettingsFromRows([]);
    expect(s.branding).toMatchObject({ company: 'Koala Insulation', license: null, phone: null, email: null, website: null });
    expect([s.terms, s.warranty]).toEqual([DEFAULT_TERMS, DEFAULT_WARRANTY]);
  });

  it('the migration writes the same words the code prints (supabase/migrations/20261119000001_accuracy.sql)', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase/migrations/20261119000001_accuracy.sql'), 'utf8');
    const section = sql.slice(sql.indexOf('owner decisions OD12 and OD13'));
    expect(section).toContain(`set value = to_jsonb('${DEFAULT_TERMS}'::text)`);
    expect(section).toContain(`set value = to_jsonb('${DEFAULT_WARRANTY}'::text)`);
    expect(section).toContain(`'{"company": "${DEFAULT_COMPANY}"}'::jsonb`);
  });

  it('any stored text that says PLACEHOLDER is not filled in: the default prints, or the detail is left off', () => {
    const s = quoteSettingsFromRows([
      {
        key: 'branding',
        value: { company: 'PLACEHOLDER company', license: 'placeholder', phone: 'PLACEHOLDER — office phone', email: 'placeholder@example.com', website: 'Placeholder.example' },
      },
      { key: 'quote_terms', value: 'Terms — PLACEHOLDER, owner to replace' },
      { key: 'warranty_text', value: 'Workmanship warranty — PLACEHOLDER, owner to replace.' },
    ]);
    expect(s.branding).toMatchObject({ company: 'Koala Insulation', license: null, phone: null, email: null, website: null });
    expect(s.terms).toBe(DEFAULT_TERMS);
    expect(s.warranty).toBe('Limited lifetime warranty');
    // A real value is printed as the owner wrote it.
    const owner = quoteSettingsFromRows([
      { key: 'branding', value: { company: ' Koala Insulation of Springfield ', license: 'HIC 77-0042', phone: '(555) 010-0199' } },
      { key: 'warranty_text', value: 'Limited lifetime warranty on materials and workmanship.' },
    ]);
    expect(owner.branding).toMatchObject({ company: 'Koala Insulation of Springfield', license: 'HIC 77-0042', phone: '(555) 010-0199' });
    expect(owner.warranty).toBe('Limited lifetime warranty on materials and workmanship.');
  });
});

describe('OD14: the consent sentence never throws and never needs a state in the settings', () => {
  it('a code that is not a state (or none) gives the state-neutral sentence', () => {
    for (const code of ['', 'XX', '  ', null, undefined]) {
      expect(() => esignConsent(code)).not.toThrow();
      expect(esignConsent(code), String(code)).toBe(NEUTRAL_CONSENT);
    }
    expect(esignConsent('pa')).toContain('(ESIGN Act and Pennsylvania UETA)');
  });

  it("the property's state when it is a real state, else the shop address's, else neutral", () => {
    const shop = [{ key: 'shop_address', value: '100 Main St, Springfield, IL 62701' }];
    expect(profile.consentState(shop, 'PA')).toBe('PA');
    expect(profile.consentState(shop, 'pa')).toBe('PA');
    expect(profile.consentState(shop, 'XX')).toBe('IL');
    expect(profile.consentState(shop, '')).toBe('IL');
    expect(profile.consentState([], 'XX')).toBeNull();
    expect(profile.consentState([{ key: 'shop_address', value: 'somewhere' }], '')).toBeNull();
    // A state saved on the optional profile page is not a source (OD14 names only these two).
    expect(profile.consentState([{ key: 'default_state', value: 'NJ' }], '')).toBeNull();
    expect(profile.quoteSettingsForSend([], 'XX').consent).toBe(NEUTRAL_CONSENT);
    expect(profile.quoteSettingsForSend(shop, 'XX').consent).toContain('(ESIGN Act and Illinois UETA)');
  });
});

describe('flow-B1 (c): a quote number never starts with a blank or a bad prefix', () => {
  it("a stored prefix that is not 1 to 6 capitals or digits falls back to 'KN' (OD16)", () => {
    const rows = (v: unknown) => [{ key: 'quote_number_prefix', value: v }];
    expect(profile.quoteSettingsForSend(rows('AB'), 'IL').prefix).toBe('AB');
    for (const bad of ['', '  ', 'k-n', 'TOOLONG7', 'PLACEHOLDER', null, { prefix: 'AB' }]) {
      expect(profile.quoteSettingsForSend(rows(bad), 'IL').prefix, String(bad)).toBe('KN');
    }
    expect(profile.quoteSettingsForSend([], 'IL').prefix).toBe('KN');
  });
});

describe('DOC-2 / OD14: a new estimate starts in the town and state of the shop address, as a pair', () => {
  it('the shop address when it parses, else both blank; never a town from one place and a state from another', () => {
    expect(profile.newEstimateDefaults([{ key: 'shop_address', value: 'Springfield, IL 62701' }])).toEqual({ city: 'Springfield', state: 'IL' });
    expect(profile.newEstimateDefaults([{ key: 'shop_address', value: '12 Main St, Springfield, IL' }])).toEqual({ city: 'Springfield', state: 'IL' });
    // Review A DOC-2: state PA saved with no town, and the shop in Delaware, gave "Newark, PA".
    expect(profile.newEstimateDefaults([{ key: 'default_state', value: 'PA' }, { key: 'shop_address', value: 'Newark, DE 19711' }])).toEqual({ city: 'Newark', state: 'DE' });
    expect(profile.newEstimateDefaults([{ key: 'default_state', value: 'NJ' }, { key: 'shop_address', value: '500 Market St, Philadelphia, PA 19106' }])).toEqual({
      city: 'Philadelphia',
      state: 'PA',
    });
    expect(profile.newEstimateDefaults([{ key: 'default_city', value: 'Bear' }, { key: 'default_state', value: 'DE' }])).toEqual({ city: '', state: '' });
    expect(profile.newEstimateDefaults([{ key: 'shop_address', value: 'the shop' }])).toEqual({ city: '', state: '' });
    expect(profile.newEstimateDefaults([])).toEqual({ city: '', state: '' });
    expect(profile.newEstimateDefaults(SEEDED)).toEqual({ city: 'Newark', state: 'DE' });
  });
});

describe('OD12 / DOC-1 / DOC-3: nothing blocks a send or asks anyone to finish a business profile', () => {
  it('the phone is told where new estimates start, and nothing about gaps', () => {
    expect(profile.businessInfo(LIVE_BEFORE)).toEqual({ newEstimate: { city: 'Newark', state: 'DE' } });
    expect('businessProfileGaps' in profile).toBe(false);
    expect('profileGapsSentence' in profile).toBe(false);
  });

  it('no part of the app carries the gate or its words (estimator, office and owner alike)', () => {
    const root = process.cwd();
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !/\.test\.(ts|tsx)$/.test(e.name)) files.push(rel);
      }
    };
    ['app', 'lib', 'components', 'public'].forEach(walk);
    const found = files.flatMap((f) => {
      const text = fs.readFileSync(path.join(root, f), 'utf8');
      return [/setup_incomplete/, /finish the business profile|or the office to finish/i, /business profile is not finished/i, /Business profile finished/, /businessProfileGaps|profileGapsSentence/, /A quote cannot be sent until/].filter((re) => re.test(text)).map((re) => `${f}: ${re}`);
    });
    expect(found).toEqual([]);
  });
});
