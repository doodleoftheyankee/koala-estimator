'use server';
// Owner-only save of the blower door tool's rebate programs (app_settings.blower_door).
// Re-checks the owner, validates every rule (lib/blowerdoor/settings.ts), and writes with the
// signed-in user's client so RLS applies and the audit trigger records the owner as the actor.
// Phones pick the change up the next time they sync; readings already saved keep the program as it
// was when they were taken.
import { revalidatePath } from 'next/cache';
import { failure, success, type ActionResult } from '@/lib/admin/forms';
import { SETTINGS_KEY, validateBlowerDoorSettings } from '@/lib/blowerdoor';
import { getSessionProfile } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';

const DESCRIPTION = 'Blower door tool: rebate programs, the gauge and its defaults (Rebate programs page)';

export async function saveRebatePrograms(_prev: ActionResult | null, fd: FormData): Promise<ActionResult> {
  const profile = await getSessionProfile();
  if (!profile || profile.role !== 'owner') return failure('Only the owner can change the rebate programs.');

  const raw = fd.get('settings');
  let input: unknown;
  try {
    input = typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch {
    return failure('The form could not be read. Reload the page and try again.');
  }
  const r = validateBlowerDoorSettings(input);
  if (!r.ok) return failure(r.errors.join(' · '));

  const db = await createClient();
  const write = await db
    .from('app_settings')
    .upsert({ key: SETTINGS_KEY, value: r.value, description: DESCRIPTION, updated_at: new Date().toISOString(), updated_by: profile.userId }, { onConflict: 'key' })
    .select('key');
  if (write.error) return failure(write.error.code === '42501' ? 'Only the owner can change the rebate programs.' : `Saving failed: ${write.error.message}`);
  if ((write.data ?? []).length !== 1) return failure('Only the owner can change the rebate programs.');

  revalidatePath('/admin/rebates');
  const n = r.value.programs.length;
  return success(n === 0 ? 'Saved. No programs: the tool shows the reduction and the ventilation check only.' : `Saved ${n} program${n === 1 ? '' : 's'}. Phones get them the next time they sync.`);
}
