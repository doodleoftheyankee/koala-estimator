// How a customer reaches us, inside a sentence, verb included (owner decision OD12: never "call our
// office" without a number). The same order as the quote page's OfficeContact (app/q/[token]/parts):
// the office phone when the branding has one, else the estimator's own email, else the office email,
// else the email that brought them to the quote. Pure; from the quote's own document.
import { formatPhone } from '@/lib/format';
import type { QuoteDocument } from './model';

export function reachUs(doc: Pick<QuoteDocument, 'branding' | 'estimator'>): string {
  if (doc.branding.phone) return `call ${formatPhone(doc.branding.phone)}`;
  if (doc.estimator.email) return `email ${doc.estimator.name} at ${doc.estimator.email}`;
  if (doc.branding.email) return `email ${doc.branding.email}`;
  return 'reply to the email that brought you here';
}
