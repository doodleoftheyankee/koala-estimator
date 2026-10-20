'use client';
import type { EstimateDraft } from '@/lib/sync/draft';
import { Card, Field, Input, Textarea, Toggle } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import type { Update } from './EstimateEditor';

export function CustomerStep({ draft, update }: { draft: EstimateDraft; update: Update }) {
  const c = draft.customer;
  const p = draft.property;
  const setC = (patch: Partial<EstimateDraft['customer']>) => update((d) => ({ ...d, customer: { ...d.customer, ...patch } }));
  const setP = (patch: Partial<EstimateDraft['property']>) => update((d) => ({ ...d, property: { ...d.property, ...patch } }));

  return (
    <>
      <Card>
        <h2 className="mb-3 font-semibold">Customer</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First name">
            <Input autoComplete="off" value={c.firstName} onChange={(e) => setC({ firstName: e.target.value })} />
          </Field>
          <Field label="Last name">
            <Input autoComplete="off" value={c.lastName} onChange={(e) => setC({ lastName: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 space-y-3">
          <Field label="Email" hint="The quote is emailed here.">
            <Input type="email" inputMode="email" autoComplete="off" value={c.email ?? ''} onChange={(e) => setC({ email: e.target.value })} />
          </Field>
          <Field label="Mobile phone">
            <Input type="tel" inputMode="tel" autoComplete="off" value={c.phone ?? ''} onChange={(e) => setC({ phone: e.target.value })} />
          </Field>
          <Toggle
            checked={c.smsConsent}
            onChange={(v) => setC({ smsConsent: v })}
            label="OK to text about this quote"
            hint="Only turn on if the customer said yes. Recorded with a timestamp."
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 font-semibold">Property</h2>
        <div className="space-y-3">
          <Field label="Street address">
            <Input autoComplete="off" value={p.street} onChange={(e) => setP({ street: e.target.value })} />
          </Field>
          <div className="grid grid-cols-6 gap-3">
            <Field label="City" className="col-span-3">
              <Input value={p.city} onChange={(e) => setP({ city: e.target.value })} />
            </Field>
            <Field label="State" className="col-span-1">
              <Input maxLength={2} value={p.state} onChange={(e) => setP({ state: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="ZIP" className="col-span-2">
              <Input inputMode="numeric" maxLength={10} value={p.zip} onChange={(e) => setP({ zip: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Year built">
              <NumberInput allowDecimal={false} value={p.yearBuilt} onValue={(v) => setP({ yearBuilt: v === null ? null : Math.round(v) })} />
            </Field>
            <Field label="Electric utility">
              <Input list="utilities" value={p.utility ?? ''} onChange={(e) => setP({ utility: e.target.value || null })} />
              <datalist id="utilities">
                <option value="Delmarva Power" />
                <option value="City of Newark" />
                <option value="Delaware Electric Co-op" />
                <option value="DEMEC municipal" />
              </datalist>
            </Field>
          </div>
        </div>
      </Card>

      <Card>
        <Field label="Notes for the quote" hint="Printed on the customer's quote.">
          <Textarea rows={3} value={draft.notes} onChange={(e) => update((d) => ({ ...d, notes: e.target.value }))} />
        </Field>
      </Card>
    </>
  );
}
