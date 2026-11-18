import type { ReactNode } from 'react';
import { StaffShell } from '@/components/shell/StaffShell';

// The staff app shell (menu, tab bar, account menu) around the field app and Roof lookup, in the
// field register. The service worker keeps these pages (public/sw.js), shell included, so the
// menu opens with no signal too. The field app hides the tab bar while an estimate is open.
export default function FieldLayout({ children }: { children: ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
