// The customer quote page (app/q/[token]): its figures, its one hi-vis button, the chosen option's
// look, the franchise details and the unchanged signing form. The page's parts live next to the
// page; this file sits here because vitest collects tests from lib/ and components/.
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClosedState, ContactCard, Masthead, OfficeContact, QuoteIntro, ReachUsAction, SignedSummary, TermsCard } from '@/app/q/[token]/parts';
import { initials, licenseLine, longDate, monthlyFigure, price, priceExact, shortDate, telHref, webHref, type QuoteOptionView } from '@/app/q/[token]/quote-view';
import { CHOSEN_CARD_STYLE, SignForm } from '@/app/q/[token]/SignForm';
import { CircleCheck } from '@/components/daymark/icons';
import { priceEstimate } from '@/lib/pricing';
import { coefficients, snapshot } from '@/lib/pricing/__fixtures__/seed';
import { newArea, newDraft, toEstimateInput } from '@/lib/sync/draft';
import { ESIGN_CONSENT } from './consent';
import { financingLine } from './email';
import { buildQuoteDocument, formatUsd, type Branding, type QuoteDocument } from './model';

const html = (el: ReactElement) => renderToStaticMarkup(el);

// A franchise that is not the first one, so nothing about any franchise can be typed in the page.
const BRAND: Branding = {
  company: 'Acme Attics of Springfield',
  license: 'HIC 77-0042',
  phone: '(555) 010-0199',
  email: 'office@acme.example',
  website: 'acme.example',
  primaryColor: '#7c3aed',
  logoUrl: null,
};

function makeDoc(branding: Branding = BRAND): QuoteDocument {
  const d = newDraft(new Date('2026-10-20T12:00:00Z'));
  d.customer = { ...d.customer, firstName: 'Robin', lastName: 'Vale', email: 'robin@example.com' };
  d.property = { ...d.property, street: '9 Elm Ct', city: 'Springfield', state: 'IL', zip: '62701' };
  d.areas = [{ ...newArea('attic'), sqft: 1000 }];
  const priced = priceEstimate(toEstimateInput(d), snapshot, coefficients);
  return buildQuoteDocument({
    draft: d,
    options: priced.options,
    version: 1,
    issuedAt: new Date('2026-10-20T12:00:00Z'),
    validDays: 30,
    branding,
    estimator: { name: 'Sam Rivera', email: 'sam@acme.example' },
    terms: 'Terms as the franchise wrote them.',
    warranty: 'Warranty as the franchise wrote it.',
  });
}

/** The page's option views, built the way page.tsx builds them. */
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

function form(doc: QuoteDocument, opts: Partial<{ options: QuoteOptionView[]; tier: QuoteDocument['recommendedTier'] }> = {}) {
  const options = opts.options ?? views(doc);
  const tier = opts.tier === undefined ? doc.recommendedTier : opts.tier;
  return html(
    createElement(SignForm, {
      token: 'x'.repeat(43),
      options,
      recommendedTier: doc.recommendedTier,
      defaultTier: tier,
      pdfHref: '/api/public/quotes/x/pdf',
      quoteNumber: doc.quoteNumber,
      validUntil: doc.validUntil,
      intro: createElement(QuoteIntro, { doc }),
      contacts: createElement(ContactCard, { estimator: doc.estimator, branding: doc.branding }),
    }),
  );
}

/** Class tokens that paint the hi-vis fill (not the hover shade). */
const HIVIS_FILL = /class="[^"]*(?<![\w:-])bg-hivis(?![\w-])/g;

describe('quote page figures come from the quote, formatted as before', () => {
  it('whole dollars and exact cents match the PDF and the old page', () => {
    for (const n of [0, 5, 999.5, 3220, 4094.08, 5060, 12345.67]) {
      expect(price(n)).toBe(formatUsd(n));
      expect(priceExact(n)).toBe(formatUsd(n, true));
    }
  });

  it('the intro says when the quote was issued, as the PDF does (RC-6)', () => {
    const doc = makeDoc();
    const out = html(createElement(QuoteIntro, { doc })).replace(/<[^>]+>/g, '');
    expect(out).toContain(`Issued ${longDate(doc.issuedAt)}`);
    expect(out).toContain(`Quote ${doc.quoteNumber}`);
  });

  it('a date-only "price holds until" never shifts a day', () => {
    expect(shortDate('2026-12-18')).toBe('Dec 18, 2026');
    expect(longDate('2026-12-18')).toBe('December 18, 2026');
    expect(longDate('2026-01-01')).toBe('January 1, 2026');
    // A timestamp is read in the business time zone (late evening UTC-5 stays the same day).
    expect(longDate('2026-11-18T03:30:00Z')).toBe('November 17, 2026');
  });

  it('the monthly figure is the one the financing line already states', () => {
    for (const f of [
      { provider: null, apr: 0.0999, termMonths: 60, monthly: 107.53 },
      { provider: 'Lender', apr: 0.0899, termMonths: 120, monthly: 64.01 },
      { provider: null, apr: 0, termMonths: 12, monthly: 421.67 },
      { provider: null, apr: 0.05, termMonths: 36, monthly: 100 },
    ]) {
      expect(financingLine(f)).toContain(`As low as ${monthlyFigure(f)}/mo for ${f.termMonths} months`);
    }
  });

  it('links, initials and the licence line', () => {
    expect(telHref('(555) 010-0199')).toBe('tel:5550100199');
    expect(telHref('+1 555 010 0199')).toBe('tel:+15550100199');
    expect(webHref('acme.example')).toBe('https://acme.example');
    expect(webHref('https://acme.example/x')).toBe('https://acme.example/x');
    expect(initials('Sam Rivera')).toBe('SR');
    expect(initials('  Cher ')).toBe('C');
    expect(initials('Mary Jo de la Cruz')).toBe('MC');
    expect(initials('')).toBe('');
    expect(licenseLine({ license: 'HIC 77-0042' })).toBe('License HIC 77-0042');
    expect(licenseLine({ license: null })).toBeNull();
  });

  it('every dollar figure on the open quote is a value from the quote', () => {
    const doc = makeDoc();
    doc.options = doc.options.map((o) => ({ ...o, financing: { provider: 'Lender', apr: 0.0999, termMonths: 60, monthly: o.price / 47 } }));
    const allowed = new Set<string>();
    for (const o of doc.options) {
      allowed.add(price(o.price));
      allowed.add(priceExact(o.price));
      if (o.financing) allowed.add(monthlyFigure(o.financing));
      for (const it of o.items) allowed.add(price(it.price));
    }
    for (const tier of ['good', 'better', 'best'] as const) {
      const out = form(doc, { tier });
      const shown = out.match(/\$[\d,]+(?:\.\d\d)?/g) ?? [];
      expect(shown.length).toBeGreaterThan(5);
      for (const s of shown) expect(allowed, `${s} is not a figure from the quote`).toContain(s);
    }
  });
});

describe('the open quote', () => {
  const doc = makeDoc();

  it('has exactly one hi-vis element: Review and sign, with its ink edge', () => {
    const out = form(doc);
    const fills = out.match(HIVIS_FILL) ?? [];
    expect(fills).toHaveLength(1);
    const button = out.slice(out.lastIndexOf('<button', out.indexOf('Review and sign')), out.indexOf('Review and sign'));
    expect(button).toMatch(/(?<![\w:-])bg-hivis(?![\w-])/);
    expect(button).toContain('border-color:var(--hivis-edge)');
    expect(button).toContain('border-width:var(--bw-go)');
  });

  it('the page asks for hi-vis in one place only, and types no colours', () => {
    // A disabled button renders without hi-vis, so the source is checked as well as the markup.
    const dir = path.join(process.cwd(), 'app/q/[token]');
    const src = fs
      .readdirSync(dir)
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n');
    expect(src.match(/variant(?:=|: )["']primary["']/g)).toHaveLength(1);
    expect(src).not.toMatch(/(?<![\w:-])bg-hivis(?![\w-])/);
    // The only colour written in is the signature's ink, which is stored with the signed quote.
    expect(new Set(src.match(/#[0-9a-fA-F]{6}\b/g))).toEqual(new Set(['#0f172a']));
  });

  it('the final Sign and accept button is the quiet main action, not hi-vis', () => {
    const out = form(doc);
    const start = out.lastIndexOf('<button', out.indexOf('Sign and accept'));
    const button = out.slice(start, out.indexOf('</button>', start));
    expect(button).not.toMatch(/(?<![\w:-])bg-hivis(?![\w-])/);
    expect(button).toContain('Sign and accept');
  });

  it('the chosen option gets the wash and an ink edge set inline; the others do not', () => {
    const out = form(doc);
    const radios = out.match(/<button[^>]*role="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(doc.options.length);
    const chosen = radios.filter((r) => r.includes('aria-checked="true"'));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]).toContain('background-color:var(--chosen-fill)');
    expect(chosen[0]).toContain('border-color:var(--chosen-edge)');
    for (const r of radios.filter((x) => x.includes('aria-checked="false"'))) expect(r).not.toContain('--chosen-fill');
    expect(CHOSEN_CARD_STYLE.boxShadow).toContain('var(--bw-go)');
  });

  it('starts on the recommended option and tags it, once', () => {
    const out = form(doc);
    expect(doc.recommendedTier).toBe('better');
    expect(out.match(/Recommended/g)).toHaveLength(1);
    const chosen = (out.match(/<button[^>]*aria-checked="true"[^>]*>[\s\S]*?<\/button>/) ?? [''])[0];
    expect(chosen).toContain('Better');
    expect(chosen).toContain('Recommended');
  });

  it('shows financing only when the quote carries it', () => {
    const without = form({ ...doc, options: doc.options.map((o) => ({ ...o, financing: null })) });
    expect(without).not.toContain('/mo');
    const withFin = { ...doc, options: doc.options.map((o) => ({ ...o, financing: { provider: 'Lender', apr: 0.0999, termMonths: 60, monthly: 101.54 } })) };
    const out = form(withFin);
    expect(out).toContain('$102/mo');
    expect(out).toContain('As low as $102/mo for 60 months at 9.99% APR, subject to credit approval. Financing through Lender.');
  });

  it('keeps the signing form legally identical', () => {
    const out = form(doc);
    const better = doc.options.find((o) => o.tier === 'better')!;
    expect(out).toContain(ESIGN_CONSENT.replace(/'/g, '&#x27;'));
    expect(out.match(/type="checkbox"/g)).toHaveLength(1);
    expect(out).toContain('Your full name');
    expect(out).toContain('autoComplete="name"');
    expect(out).toContain('aria-label="Signature pad: draw your signature with your finger or mouse"');
    expect(out).toContain(`Sign and accept ${price(better.price)}`);
    expect(out).toContain(priceExact(better.price));
    expect(out.match(/<canvas/g)).toHaveLength(1);
  });

  it('the signature pad stays paper-white in every theme (Day, quiet, on the pad itself)', () => {
    const out = form(doc);
    expect(out).toMatch(/data-theme="day" data-register="quiet"[^>]*>\s*<canvas/);
  });

  it('shows the franchise and the people from the quote, and nothing typed in', () => {
    const out = form(doc) + html(createElement(Masthead, { branding: doc.branding }));
    for (const s of ['Acme Attics of Springfield', '(555) 010-0199', 'License HIC 77-0042', 'Sam Rivera', 'Robin Vale', '9 Elm Ct, Springfield, IL 62701', doc.quoteNumber]) {
      expect(out).toContain(s);
    }
    // The consent text is the legal library's (lib/quotes/consent.ts), not this page's.
    const page = out.replace(ESIGN_CONSENT.replace(/'/g, '&#x27;'), '');
    expect(page).not.toMatch(/Newark|Delaware|\(302\)|Koala Insulation/);
  });
});

describe('the franchise header', () => {
  it('name, phone, licence line and a named Call button; the colour only in the tile', () => {
    const out = html(createElement(Masthead, { branding: BRAND }));
    expect(out).toContain('Acme Attics of Springfield');
    expect(out).toContain('(555) 010-0199 · License HIC 77-0042');
    expect(out).toMatch(/<a href="tel:5550100199" aria-label="Call Acme Attics of Springfield at \(555\) 010-0199"/);
    // The franchise colour sits on one aria-hidden tile with no text.
    const colour = out.match(/<span aria-hidden="true"[^>]*style="background-color:#7c3aed"[^>]*><\/span>/g) ?? [];
    expect(colour).toHaveLength(1);
    expect(out.match(/#7c3aed/g)).toHaveLength(1);
  });

  it('no phone: no Call button; no branding at all: a plain rule', () => {
    expect(html(createElement(Masthead, { branding: { ...BRAND, phone: null } }))).not.toContain('tel:');
    expect(html(createElement(Masthead, { branding: null }))).not.toContain('<header');
  });
});

describe('closed states', () => {
  const doc = makeDoc();

  it('keep the quote number, say what happened and offer one action', () => {
    const out = html(
      createElement(
        ClosedState,
        {
          quoteNumber: doc.quoteNumber,
          icon: CircleCheck,
          title: 'This quote has expired',
          action: createElement(ReachUsAction, { branding: doc.branding, estimator: doc.estimator }),
          aside: createElement(ContactCard, { estimator: doc.estimator, branding: doc.branding }),
        },
        createElement('p', null, 'Prices may have changed.'),
      ),
    );
    // The number keeps its own case inside the capitals label ("…-v1", as on the PDF).
    expect(out).toContain(`Quote <span class="normal-case">${doc.quoteNumber}</span>`);
    expect(out.match(/<h1/g)).toHaveLength(1);
    expect(out.match(/<main/g)).toHaveLength(1);
    expect(out).toContain('Call (555) 010-0199');
    expect(out).toContain('Questions about this quote?');
  });

  it('the action falls back to emailing the estimator, then the office', () => {
    expect(html(createElement(ReachUsAction, { branding: { ...BRAND, phone: null }, estimator: doc.estimator }))).toContain('Email Sam Rivera');
    expect(html(createElement(ReachUsAction, { branding: { ...BRAND, phone: null }, estimator: { name: 'Sam', email: null } }))).toContain('Email Acme Attics of Springfield');
    expect(html(createElement(ReachUsAction, { branding: { ...BRAND, phone: null, email: null }, estimator: null }))).toContain('Visit our website');
    expect(html(createElement(ReachUsAction, { branding: { ...BRAND, phone: null, email: null, website: null }, estimator: null }))).toBe('');
  });

  it('a closed quote always says how to get in touch, even with no office phone (RV-11)', () => {
    const say = (branding: typeof BRAND | null, estimator: typeof doc.estimator | null) =>
      html(createElement(OfficeContact, { branding, estimator, capital: true })).replace(/<[^>]+>/g, '');
    expect(say(BRAND, doc.estimator)).toBe('Call (555) 010-0199');
    expect(say({ ...BRAND, phone: null }, doc.estimator)).toBe('Email Sam Rivera');
    expect(say({ ...BRAND, phone: null }, null)).toBe(`Email ${BRAND.email}`);
    expect(say({ ...BRAND, phone: null, email: null }, null)).toBe('Reply to the email that brought you here');
    expect(say(null, null)).not.toMatch(/our office/);
  });

  it('the contact card leaves out an office with no way to reach it', () => {
    const none = { ...BRAND, phone: null, email: null, website: null };
    expect(html(createElement(ContactCard, { estimator: null, branding: none }))).toBe('');
    expect(html(createElement(ContactCard, { estimator: doc.estimator, branding: none }))).not.toContain(BRAND.company);
  });

  it('a signed quote shows the signed price to the cent', () => {
    const out = html(createElement(SignedSummary, { tier: 'better', label: 'Air Seal + Blown Cellulose', price: 5060 }));
    expect(out).toContain('$5,060.00');
    expect(out).toContain('Signed');
  });

  it('warranty and terms are the franchise’s own words, with the PDF', () => {
    const out = html(createElement(TermsCard, { doc, pdfHref: '/pdf' }));
    expect(out).toContain('Warranty as the franchise wrote it.');
    expect(out).toContain('Terms as the franchise wrote them.');
    expect(out).toContain('href="/pdf"');
  });
});
