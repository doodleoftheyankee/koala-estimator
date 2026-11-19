import type { Metadata } from 'next';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { parseBlowerDoorSettings, SETTINGS_KEY, toStored } from '@/lib/blowerdoor';
import { Banner, Tag } from '@/components/daymark';
import { PageHeader } from '@/components/shell';
import { RebatesEditor } from './RebatesEditor';

export const metadata: Metadata = { title: 'Rebate programs' };

// The air sealing rebate programs the blower door tool uses, as franchise settings: each program's
// tiers (reduction and rebate), cost cap, ventilation rebate, source and effective date and the
// test-out paperwork, plus the gauge and the default flow exponent and N-factor. The owner edits
// them; the office reads them. Every phone caches them for offline use.
export default async function RebatesPage() {
  const profile = await requireRole('owner', 'office');
  const readOnly = profile.role !== 'owner';
  const db = await createClient();
  const { data, error } = await db.from('app_settings').select('value, updated_at').eq('key', SETTINGS_KEY).maybeSingle();
  const { settings, problems } = parseBlowerDoorSettings(data?.value ?? null);

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6 md:px-6">
      <PageHeader
        title="Rebate programs"
        meta={readOnly ? <Tag tone="info">Read-only</Tag> : null}
        description="The air sealing rebate programs your franchise works with. The blower door tool shows each program's tiers, rebate, cost cap and paperwork on every phone, offline too. Phones pick changes up the next time they sync; readings already saved keep the program as it was."
      />
      {readOnly ? (
        <Banner tone="info" live={false}>
          You can view the rebate programs. Only the owner can change them.
        </Banner>
      ) : null}
      {error ? (
        <Banner tone="bad" title="The rebate programs did not load.">
          {error.message}
        </Banner>
      ) : null}
      {problems.length ? (
        <Banner tone="warn" title="Some saved values could not be used." live={false}>
          <ul className="list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {!error ? <RebatesEditor initial={toStored(settings)} readOnly={readOnly} /> : null}
    </main>
  );
}
