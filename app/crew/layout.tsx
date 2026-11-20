import type { ReactNode } from 'react';
import { StaffShell } from '@/components/shell/StaffShell';

// The staff app shell (menu, tab bar, account menu) around the crew app, in the field register.
// The service worker keeps this page (public/sw.js), shell included, so it opens with no signal.
// A crew's menu has only price-free pages (lib/nav.ts).
export default function CrewLayout({ children }: { children: ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
