import type { Metadata } from 'next';
import { z } from 'zod';
import { Alert, Badge, Card, Field, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/admin/forms';
import { BRANDING_FIELDS, objectFieldText, settingObject, toSettingsMap } from '@/lib/admin/settings';
import { esignConsent, stateName } from '@/lib/quotes/consent';
import { businessYear, counterQuoteNumber, QUOTE_PREFIX_PATTERN } from '@/lib/quotes/model';
import { businessProfileGaps, newEstimateDefaults, PROFILE_FIELDS, profileGapsSentence, profileValue } from '@/lib/quotes/profile';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { ActionForm } from '../pricing/ActionForm';
import { saveSettings } from '../pricing/actions';
import { TextField } from '../pricing/fields';

export const metadata: Metadata = { title: 'Business profile' };

// The business profile (L30-L32): what every quote prints about the franchise, the state its
// signing sentence names, the town new estimates start in, and the prefix of its quote numbers.
// A quote cannot be sent while a required field is missing (lib/quotes/profile.ts). The owner
// edits it; the office sees it, and what is missing, read-only.

const rowsSchema = z.array(z.object({ key: z.string(), value: z.unknown() }));

const hintOf = (key: string) => PROFILE_FIELDS.find((f) => f.key === key)?.hint;
const requiredKey = (key: string) => PROFILE_FIELDS.find((f) => f.key === key)?.required ?? false;

export default async function BusinessProfilePage() {
  const profile = await requireRole('owner', 'office');
  const readOnly = profile.role !== 'owner';
  const db = await createClient();

  let rows: Array<{ key: string; value: unknown }> | null = null;
  let loadError: string | null = null;
  try {
    const res = await db.from('app_settings').select('key, value').order('key');
    if (res.error) throw new Error(res.error.message);
    rows = rowsSchema.parse(res.data);
  } catch (e) {
    loadError = errorMessage(e);
  }

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-slate-900">Business profile</h1>
        {readOnly ? <Badge tone="blue">Read-only</Badge> : null}
      </div>
      {readOnly ? <Alert tone="blue">You can see the business profile. Only the owner can change it.</Alert> : null}
      {loadError || !rows ? <Alert tone="red">Could not load the business profile: {loadError}</Alert> : <ProfileContent rows={rows} readOnly={readOnly} />}
    </main>
  );
}

function ProfileContent({ rows, readOnly }: { rows: Array<{ key: string; value: unknown }>; readOnly: boolean }) {
  const map = toSettingsMap(rows);
  const brand = settingObject(map, 'branding');
  const gaps = businessProfileGaps(rows);
  const state = profileValue(rows, 'default_state').toUpperCase();
  const prefix = profileValue(rows, 'quote_number_prefix');
  const start = newEstimateDefaults(rows);
  const text = (key: string) => profileValue(rows, key);

  return (
    <>
      {gaps.length ? (
        <Alert tone="amber">
          <p className="font-semibold">{profileGapsSentence(gaps)}</p>
          <p className="mt-1">Until then no quote can be sent, so a customer never sees a blank phone or a placeholder warranty.</p>
        </Alert>
      ) : (
        <Alert tone="green">Everything a quote needs is filled in.</Alert>
      )}

      <ActionForm action={saveSettings} readOnly={readOnly} submitLabel="Save the business profile">
        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">On every quote</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {BRANDING_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={f.label}
                name={`branding.${f.key}`}
                type={f.type}
                required={f.key === 'company'}
                defaultValue={objectFieldText(brand, f.key)}
                placeholder={f.key === 'primary_color' ? '#0f766e' : undefined}
                hint={f.key === 'primary_color' ? 'Hex color, e.g. #0f766e' : hintOf(`branding.${f.key}`)}
              />
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">Where you work</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label="Town" name="default_city" defaultValue={text('default_city')} hint={hintOf('default_city')} />
            <TextField label="State" name="default_state" defaultValue={state} required={requiredKey('default_state')} placeholder="PA" hint={hintOf('default_state')} />
            <TextField
              label="Quote number prefix"
              name="quote_number_prefix"
              defaultValue={prefix}
              required={requiredKey('quote_number_prefix')}
              hint={hintOf('quote_number_prefix')}
            />
          </div>
          <ul className="mt-3 space-y-1 text-sm text-slate-600">
            <li>
              New estimates start in:{' '}
              <span className="font-semibold text-slate-800">{[start.city, start.state].filter(Boolean).join(', ') || 'no town (the estimator types it)'}</span>
            </li>
            {QUOTE_PREFIX_PATTERN.test(prefix) ? (
              <li>
                The next quote this year reads like <span className="font-semibold text-slate-800">{counterQuoteNumber(prefix, businessYear(new Date()), 1, 1)}</span> (the number counts up).
              </li>
            ) : null}
            {stateName(state) ? (
              <li>
                The signing sentence reads: <span className="text-slate-800">“{esignConsent(state)}”</span>
              </li>
            ) : null}
          </ul>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">Warranty and terms</h2>
          <div className="grid gap-4">
            <Field label="Warranty" hint={hintOf('warranty_text')}>
              <Textarea name="warranty_text" rows={5} required defaultValue={text('warranty_text')} />
            </Field>
            <Field label="Terms" hint={hintOf('quote_terms')}>
              <Textarea name="quote_terms" rows={6} required defaultValue={text('quote_terms')} />
            </Field>
          </div>
        </Card>
      </ActionForm>
    </>
  );
}
