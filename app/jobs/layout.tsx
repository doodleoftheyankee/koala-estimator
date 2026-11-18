import type { ReactNode } from 'react';
import { StaffShell } from '@/components/shell/StaffShell';

// The staff app shell (menu, tab bar, account menu), in the quiet register (app/globals.css):
// 1px rules, no keel shadows, the hi-vis wash for chosen values and plain-zero digits. Used for
// the desktop office, owner and admin screens.
export default function OfficeLayout({ children }: { children: ReactNode }) {
  return <StaffShell register="quiet">{children}</StaffShell>;
}
