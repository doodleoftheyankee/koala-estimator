// Data for the customer quote pages (/q/<token>). The layout and the page both need the quote,
// so the lookup is cached for the request: one database read however many parts ask.
import 'server-only';
import { cache } from 'react';
import { findQuoteByToken } from '@/lib/quotes/lookup';
import type { Branding } from '@/lib/quotes/model';
import { loadQuoteSettings } from '@/lib/quotes/settings';
import { createAdminClient } from '@/lib/supabase/admin';

/** The quote for a URL token, or null when there is none. Throws when the lookup fails. */
export const getQuote = cache(async (token: string) => findQuoteByToken(createAdminClient(), token));

/**
 * The franchise's current branding from its settings, for pages with no quote to read it from
 * (a link that matches no quote). Null when the settings cannot be read.
 */
export const getSettingsBranding = cache(async (): Promise<Branding | null> => {
  try {
    return (await loadQuoteSettings(createAdminClient())).branding;
  } catch (e) {
    console.error('[quote page] loading branding failed', e instanceof Error ? e.message : e);
    return null;
  }
});

/**
 * What the masthead shows on every quote page, open or closed: the branding frozen into the
 * quote when it was sent (what the customer's PDF shows too), or the current settings when the
 * link matches no quote or the quote cannot be read. Never throws: the page's own error page
 * still gets a header.
 */
export async function getMastheadBranding(token: string): Promise<Branding | null> {
  try {
    const quote = await getQuote(token);
    if (quote) return quote.document.branding;
  } catch {
    // The page reports the failure through its error page; the header falls back to settings.
  }
  return getSettingsBranding();
}
