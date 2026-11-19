import type { Metadata } from 'next';
import { z } from 'zod';
import { Alert, Badge, Card, Field, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/admin/forms';
import { BRANDING_FIELDS, objectFieldText, settingObject, toSettingsMap } from '@/lib/admin/settings';
import { businessYear, counterQuoteNumber } from '@/lib/quotes/model';
import { newEstimateDefaults, PROFILE_FIELDS, quotePrefix, quoteSettingsForSend } from '@/lib/quotes/profile';
import { requireRole } from '@/lib/server/auth';
import { createClient } from '@/lib/supabase/server';
import { ActionForm } from '../pricing/ActionForm';
import { saveSettings } from '../pricing/actions';
import { TextField } from '../pricing/fields';

export const metadata: Metadata = { title: 'Business profile' };

// The business profile: an OPTIONAL owner page (owner decision OD12). Quotes go out without it:
// they name "Koala Insulation", print "Limited lifetime warranty" and the default terms, and leave
// off a license or office phone nobody entered. Here the owner may add those later. Nothing links
// here from a warning and nothing asks anyone to fill it in. The owner edits it; the office reads it.

const rowsSchema = z.array(z.object({ key: z.string(), value: z.unknown() }));

const hintOf = (key: string) => PROFILE_FIELDS.find((f) => f.key === key)?.hint;
const labelOf = (key: string, fallback: string) => PROFILE_FIELDS.find((f) => f.key === key)?.label ?? fallback;

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
  // What quotes print today: what is saved, else the default (a PLACEHOLDER text counts as not saved).
  const { settings } = quoteSettingsForSend(rows, null);
  const prefix = quotePrefix(rows);
  const start = newEstimateDefaults(rows);
  const shown: Record<string, string | null> = {
    company: settings.branding.company,
    license: settings.branding.license,
    phone: settings.branding.phone,
    email: settings.branding.email,
    website: settings.branding.website,
  };
  const brandText = (key: string) => (key in shown ? (shown[key] ?? '') : objectFieldText(brand, key));

  return (
    <>
      <p className="text-sm text-slate-600">
        Optional. Quotes go out without it: they say {settings.branding.company}, and leave off anything not filled in here. Add an office phone or a license number when you want them on every
        quote.
      </p>

      <ActionForm action={saveSettings} readOnly={readOnly} submitLabel="Save the business profile">
        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">On every quote</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {BRANDING_FIELDS.map((f) => (
              <TextField
                key={f.key}
                label={labelOf(`branding.${f.key}`, f.label)}
                name={`branding.${f.key}`}
                type={f.type}
                required={f.key === 'company'}
                defaultValue={brandText(f.key)}
                placeholder={f.key === 'primary_color' ? '#0f766e' : undefined}
                hint={f.key === 'primary_color' ? 'Hex color, e.g. #0f766e' : hintOf(`branding.${f.key}`)}
              />
            ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">Quote numbers</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label="Quote number prefix" name="quote_number_prefix" defaultValue={prefix} required hint={hintOf('quote_number_prefix')} />
          </div>
          <ul className="mt-3 space-y-1 text-sm text-slate-600">
            <li>
              The next quote this year reads like <span className="font-semibold text-slate-800">{counterQuoteNumber(prefix, businessYear(new Date()), 1, 1)}</span> (the number counts up).
            </li>
            <li>
              New estimates start in:{' '}
              <span className="font-semibold text-slate-800">{[start.city, start.state].filter(Boolean).join(', ') || 'no town (the estimator types it)'}</span>, the town of the shop address on
              the Pricing page.
            </li>
            <li>The signing sentence names the e-sign law of the property&rsquo;s state.</li>
          </ul>
        </Card>

        <Card>
          <h2 className="mb-3 font-semibold text-slate-900">Warranty and terms</h2>
          <div className="grid gap-4">
            <Field label="Warranty" hint={hintOf('warranty_text')}>
              <Textarea name="warranty_text" rows={3} required defaultValue={settings.warranty} />
            </Field>
            <Field label="Terms" hint={hintOf('quote_terms')}>
              <Textarea name="quote_terms" rows={6} required defaultValue={settings.terms} />
            </Field>
          </div>
        </Card>
      </ActionForm>
    </>
  );
}
