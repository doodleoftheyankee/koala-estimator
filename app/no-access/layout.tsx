import type { ReactNode } from 'react';
import { StaffShell } from '@/components/shell/StaffShell';
import { getSessionProfile } from '@/lib/server/auth';

// Inside the app menu, in the register of the role's own pages: quiet for owner and office.
export default async function NoAccessLayout({ children }: { children: ReactNode }) {
  const profile = await getSessionProfile();
  const office = profile?.role === 'owner' || profile?.role === 'office';
  return <StaffShell register={office ? 'quiet' : undefined}>{children}</StaffShell>;
}
