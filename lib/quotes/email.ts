// Transactional email (Resend) and the quote email templates.
// Without RESEND_API_KEY, emails are logged instead of sent so local dev works.
import { Resend } from 'resend';
import { serverEnv } from '@/lib/env';
import type { Financing, Tier } from '@/lib/pricing';
import { formatUsd, type QuoteDocument } from './model';

/** "As low as $X/mo for N months at Y% APR, subject to credit approval" (+ provider when set). */
export function financingLine(f: Financing): string {
  const apr = Number((f.apr * 100).toFixed(2));
  const base = `As low as ${formatUsd(Math.ceil(f.monthly))}/mo for ${f.termMonths} months at ${apr}% APR, subject to credit approval`;
  return f.provider ? `${base}. Financing through ${f.provider}.` : `${base}.`;
}

export interface EmailAttachment {
  filename: string;
  content: Buffer | string;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface SendResult {
  sent: boolean;
  id?: string;
  error?: string;
}

export interface EmailTemplate {
  subject: string;
  html: string;
  text: string;
}

/** Sends an email. Never throws: failures come back as `{ sent: false, error }`. */
export async function sendEmail(msg: EmailMessage): Promise<SendResult> {
  const key = serverEnv.resendApiKey();
  if (!key) {
    console.info('[email] RESEND_API_KEY not set; not sending.', {
      to: msg.to,
      subject: msg.subject,
      text: msg.text,
      attachments: msg.attachments?.map((a) => a.filename) ?? [],
    });
    return { sent: false };
  }
  try {
    const resend = new Resend(key);
    const { data, error } = await resend.emails.send({
      from: serverEnv.quoteFromEmail(),
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content })),
    });
    if (error) {
      console.error('[email] send failed', error.message);
      return { sent: false, error: error.message };
    }
    return { sent: true, id: data?.id };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('[email] send failed', message);
    return { sent: false, error: message };
  }
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Only http(s) URLs may go into an href. */
function safeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? escapeHtml(url) : '#';
}

const TIER_NAMES: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };

export function optionName(doc: QuoteDocument, tier: Tier): string {
  const o = doc.options.find((x) => x.tier === tier);
  return o ? `${TIER_NAMES[tier]}: ${o.label}` : TIER_NAMES[tier];
}

function firstName(doc: QuoteDocument): string {
  return doc.customer.name.split(/\s+/)[0] || 'there';
}

function formatDate(isoDate: string): string {
  const d = new Date(isoDate.length === 10 ? `${isoDate}T12:00:00Z` : isoDate);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
}

function layout(doc: QuoteDocument, bodyHtml: string): string {
  const b = doc.branding;
  const color = /^#[0-9a-fA-F]{3,6}$/.test(b.primaryColor) ? b.primaryColor : '#0f766e';
  const contact = [b.phone, b.email, b.website].filter((x): x is string => !!x).map(escapeHtml).join(' &middot; ');
  return `<!doctype html><html><body style="margin:0;padding:0;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif;color:#0f172a;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;">
<tr><td style="background:${color};color:#ffffff;padding:18px 24px;font-size:20px;font-weight:bold;">${escapeHtml(b.company)}</td></tr>
<tr><td style="padding:24px;font-size:16px;line-height:1.5;">${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0;">${escapeHtml(b.company)}${b.license ? ` &middot; License ${escapeHtml(b.license)}` : ''}${contact ? `<br>${contact}` : ''}</td></tr>
</table></td></tr></table></body></html>`;
}

function button(doc: QuoteDocument, url: string, label: string): string {
  const color = /^#[0-9a-fA-F]{3,6}$/.test(doc.branding.primaryColor) ? doc.branding.primaryColor : '#0f766e';
  return `<p style="margin:24px 0;"><a href="${safeUrl(url)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:10px;">${escapeHtml(label)}</a></p>`;
}

function textFooter(doc: QuoteDocument): string {
  const b = doc.branding;
  return ['--', b.company, b.license ? `License ${b.license}` : null, b.phone, b.email, b.website].filter(Boolean).join('\n');
}

export function quoteEmail(doc: QuoteDocument, url: string): EmailTemplate {
  const company = doc.branding.company;
  const subject = `Your insulation quote from ${company} (${doc.quoteNumber})`;
  const optionRows = doc.options
    .map(
      (o) =>
        `<tr><td style="padding:6px 0;">${escapeHtml(optionName(doc, o.tier))}${o.tier === doc.recommendedTier ? ' <strong>(recommended)</strong>' : ''}</td><td style="padding:6px 0;text-align:right;font-weight:bold;">${escapeHtml(formatUsd(o.price))}</td></tr>`,
    )
    .join('');
  const html = layout(
    doc,
    `<p>Hi ${escapeHtml(firstName(doc))},</p>
<p>Thank you for having us out to ${escapeHtml(doc.property.line1)}. Your quote <strong>${escapeHtml(doc.quoteNumber)}</strong> is ready. You can review each option, pick the one that fits, and sign online.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;border-top:1px solid #e2e8f0;border-bottom:1px solid #e2e8f0;margin:12px 0;">${optionRows}</table>
${button(doc, url, 'View and sign your quote')}
<p style="font-size:14px;color:#475569;">This quote is valid until ${escapeHtml(formatDate(doc.validUntil))}. Questions? Reply to this email or contact ${escapeHtml(doc.estimator.name)}${doc.estimator.email ? ` at ${escapeHtml(doc.estimator.email)}` : ''}.</p>
<p style="font-size:12px;color:#64748b;word-break:break-all;">If the button does not work, copy this link into your browser:<br>${escapeHtml(url)}</p>`,
  );
  const text = [
    `Hi ${firstName(doc)},`,
    '',
    `Thank you for having us out to ${doc.property.line1}. Your quote ${doc.quoteNumber} is ready.`,
    '',
    ...doc.options.map(
      (o) => `- ${optionName(doc, o.tier)}: ${formatUsd(o.price)}${o.tier === doc.recommendedTier ? ' (recommended)' : ''}`,
    ),
    '',
    `View and sign your quote: ${url}`,
    '',
    `This quote is valid until ${formatDate(doc.validUntil)}. Questions? Contact ${doc.estimator.name}${doc.estimator.email ? ` at ${doc.estimator.email}` : ''}.`,
    '',
    textFooter(doc),
  ].join('\n');
  return { subject, html, text };
}

export function signedConfirmationEmail(doc: QuoteDocument, tier: Tier, price: number, pdfUrl?: string): EmailTemplate {
  const subject = `Signed: your ${doc.branding.company} quote ${doc.quoteNumber}`;
  const phone = doc.branding.phone;
  const html = layout(
    doc,
    `<p>Hi ${escapeHtml(firstName(doc))},</p>
<p>Thank you! We received your signed quote <strong>${escapeHtml(doc.quoteNumber)}</strong>.</p>
<p style="font-size:15px;background:#f8fafc;border-radius:8px;padding:12px;">Option: <strong>${escapeHtml(optionName(doc, tier))}</strong><br>Price: <strong>${escapeHtml(formatUsd(price, true))}</strong><br>Property: ${escapeHtml(doc.property.line1)}, ${escapeHtml(doc.property.line2)}</p>
${pdfUrl ? button(doc, pdfUrl, 'Download your signed quote') : ''}
<p>Our office will contact you shortly to schedule the work${phone ? `. You can also reach us at ${escapeHtml(phone)}` : ''}.</p>`,
  );
  const text = [
    `Hi ${firstName(doc)},`,
    '',
    `Thank you! We received your signed quote ${doc.quoteNumber}.`,
    `Option: ${optionName(doc, tier)}`,
    `Price: ${formatUsd(price, true)}`,
    `Property: ${doc.property.line1}, ${doc.property.line2}`,
    ...(pdfUrl ? ['', `Download your signed quote: ${pdfUrl}`] : []),
    '',
    `Our office will contact you shortly to schedule the work${phone ? `. You can also reach us at ${phone}` : ''}.`,
    '',
    textFooter(doc),
  ].join('\n');
  return { subject, html, text };
}

export function officeSignedNotice(doc: QuoteDocument, tier: Tier, price: number, estimateId: string): EmailTemplate {
  const url = `${serverEnv.appUrl()}/field?e=${encodeURIComponent(estimateId)}`;
  const subject = `Quote signed: ${doc.customer.name} - ${formatUsd(price)} (${doc.quoteNumber})`;
  const html = layout(
    doc,
    `<p><strong>${escapeHtml(doc.customer.name)}</strong> signed quote <strong>${escapeHtml(doc.quoteNumber)}</strong>.</p>
<p style="font-size:15px;background:#f8fafc;border-radius:8px;padding:12px;">Option: <strong>${escapeHtml(optionName(doc, tier))}</strong><br>Price: <strong>${escapeHtml(formatUsd(price, true))}</strong><br>Property: ${escapeHtml(doc.property.line1)}, ${escapeHtml(doc.property.line2)}<br>Customer: ${escapeHtml([doc.customer.email, doc.customer.phone].filter(Boolean).join(' / ') || 'no contact on file')}<br>Estimator: ${escapeHtml(doc.estimator.name)}</p>
${button(doc, url, 'Open the estimate')}`,
  );
  const text = [
    `${doc.customer.name} signed quote ${doc.quoteNumber}.`,
    `Option: ${optionName(doc, tier)}`,
    `Price: ${formatUsd(price, true)}`,
    `Property: ${doc.property.line1}, ${doc.property.line2}`,
    `Customer: ${[doc.customer.email, doc.customer.phone].filter(Boolean).join(' / ') || 'no contact on file'}`,
    `Estimator: ${doc.estimator.name}`,
    '',
    `Open the estimate: ${url}`,
  ].join('\n');
  return { subject, html, text };
}
