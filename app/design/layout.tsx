import type { ReactNode } from 'react';
import { StaffShell } from '@/components/shell/StaffShell';

// The staff app shell around the living system sheet (owner and office; in their account menu).
export default function DesignLayout({ children }: { children: ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
