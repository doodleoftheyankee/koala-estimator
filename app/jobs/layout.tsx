import type { ReactNode } from 'react';

// Quiet register (app/globals.css): 1px rules, no keel shadows, the hi-vis wash for chosen values
// and plain-zero digits. Used for the customer quote and the desktop office, owner and admin screens.
export default function QuietLayout({ children }: { children: ReactNode }) {
  return <div data-register="quiet">{children}</div>;
}
