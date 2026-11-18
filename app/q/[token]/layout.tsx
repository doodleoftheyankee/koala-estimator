import type { ReactNode } from 'react';
import { getMastheadBranding } from './data';
import { Masthead } from './parts';

// Every customer quote page (open, signed, closed, not found, error) sits under the same
// franchise header, so the layout draws it: the branding frozen into the quote, or the franchise
// settings when the link matches no quote.
//
// Quiet register (app/globals.css): 1px rules, no keel shadows, the hi-vis wash for chosen values
// and plain-zero digits, for the customer.
export default async function QuoteLayout({ children, params }: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  const branding = await getMastheadBranding(token);
  return (
    <div data-register="quiet" className="min-h-dvh bg-canvas text-ink">
      <Masthead branding={branding} />
      {children}
    </div>
  );
}
