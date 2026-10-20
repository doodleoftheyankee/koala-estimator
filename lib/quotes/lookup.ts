// Server-side lookup of a quote by its public token (customer pages and public endpoints).
// Uses the service-role client because the customer has no session; callers must only
// expose the customer-facing `document`, never the rest of the snapshot.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Tier } from '@/lib/pricing';
import type { QuoteDocument } from './model';
import { hashQuoteToken, isWellFormedToken } from './token';

export type QuoteStatus = 'sent' | 'viewed' | 'signed' | 'declined' | 'expired' | 'superseded';

export interface PublicQuoteRow {
  id: string;
  estimate_id: string;
  version: number;
  status: QuoteStatus;
  pdf_path: string;
  pdf_sha256: string;
  expires_at: string;
  first_viewed_at: string | null;
  signed_at: string | null;
  signed_tier: Tier | null;
  signed_price: number | string | null;
  signer_name: string | null;
  signed_pdf_path: string | null;
  document: QuoteDocument;
}

const COLUMNS =
  'id, estimate_id, version, status, pdf_path, pdf_sha256, expires_at, first_viewed_at, signed_at, signed_tier, signed_price, signer_name, signed_pdf_path, snapshot';

/** Returns the quote for a raw URL token, or null when the token is malformed or unknown. */
export async function findQuoteByToken(admin: SupabaseClient, token: string): Promise<PublicQuoteRow | null> {
  if (!isWellFormedToken(token)) return null;
  const { data, error } = await admin.from('quotes').select(COLUMNS).eq('public_token_hash', hashQuoteToken(token)).maybeSingle();
  if (error) throw new Error(`Quote lookup failed: ${error.message}`);
  if (!data) return null;
  const { snapshot, ...rest } = data as Omit<PublicQuoteRow, 'document'> & { snapshot: { document?: QuoteDocument } | null };
  const document = snapshot?.document;
  if (!document || !Array.isArray(document.options)) throw new Error('Quote snapshot has no document');
  return { ...rest, document };
}

export function isExpired(row: Pick<PublicQuoteRow, 'expires_at'>, now = new Date()): boolean {
  return new Date(row.expires_at).getTime() < now.getTime();
}
