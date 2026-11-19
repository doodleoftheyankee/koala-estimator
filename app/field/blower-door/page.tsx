import type { Metadata } from 'next';
import { requireRole } from '@/lib/server/auth';
import { BlowerDoorTool } from './BlowerDoorTool';

export const metadata: Metadata = { title: 'Blower door' };

// The blower door air seal calculator, in the field register. Opened from a job (?job=) or an
// estimate (?estimate=) it saves the test-in and test-out to it; on its own it is a plain
// calculator. Everything below this page runs on the phone against IndexedDB, and the service
// worker keeps this page (public/sw.js), so it works with no signal. It shows no prices: the
// rebate amounts are the programs', and a crew never types the air sealing price.
export default async function BlowerDoorPage() {
  const profile = await requireRole('owner', 'office', 'estimator', 'crew');
  return <BlowerDoorTool profile={{ userId: profile.userId, fullName: profile.fullName, role: profile.role }} />;
}
