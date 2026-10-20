'use client';
import { useState } from 'react';
import type { PricedOption, PricingBundle, Tier } from '@/lib/pricing';
import type { CachedProfile } from '@/lib/offline/db';
import type { EstimateDraft } from '@/lib/sync/draft';
import { num, pct, TIER_LABELS, usd } from '@/lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select, cx } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import type { PricingResult, Update } from './EstimateEditor';

export function OptionsStep({
  draft,
  update,
  bundle,
  priced,
  profile,
  online,
}: {
  draft: EstimateDraft;
  update: Update;
  bundle: PricingBundle | null;
  priced: PricingResult;
  profile: CachedProfile;
  online: boolean;
}) {
  const settings = bundle?.snapshot.settings;
  const showCosts = profile.role !== 'estimator' || !!settings?.estimatorsSeeCosts;
  const [lookup, setLookup] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });

  async function lookupDrive() {
    const p = draft.property;
    setLookup({ busy: true, msg: null });
    try {
      const res = await fetch(`/api/drive-time?address=${encodeURIComponent(`${p.street}, ${p.city}, ${p.state} ${p.zip}`)}`);
      const body = (await res.json()) as { minutes?: number; error?: string };
      if (res.ok && typeof body.minutes === 'number') {
        update((d) => ({ ...d, driveMinutesOneWay: body.minutes! }));
        setLookup({ busy: false, msg: null });
      } else setLookup({ busy: false, msg: body.error ?? 'Lookup failed.' });
    } catch {
      setLookup({ busy: false, msg: 'Lookup failed. Enter minutes by hand.' });
    }
  }

  return (
    <>
      <Card>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Crew">
            <Select value={draft.crewId ?? ''} onChange={(e) => update((d) => ({ ...d, crewId: e.target.value || null }))}>
              <option value="">Default crew</option>
              {bundle?.snapshot.crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.size})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Drive (min, one way)">
            <NumberInput allowDecimal={false} value={draft.driveMinutesOneWay} onValue={(v) => update((d) => ({ ...d, driveMinutesOneWay: v }))} />
          </Field>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={lookupDrive} disabled={!online || lookup.busy || !draft.property.street}>
            {lookup.busy ? 'Looking up…' : 'Look up drive time'}
          </Button>
          {lookup.msg ? <span className="text-xs text-amber-800">{lookup.msg}</span> : null}
        </div>
      </Card>

      {!priced ? <Alert tone="blue">Add an area with square footage to see prices.</Alert> : null}
      {priced?.error ? <Alert tone="red">Pricing setup problem: {priced.error}. Tell the office.</Alert> : null}

      {priced?.ok?.warnings.map((w, i) => (
        <Alert key={i} tone="amber">
          {w.message}
        </Alert>
      ))}

      {priced?.ok?.options.map((o) => (
        <OptionCard
          key={o.tier}
          option={o}
          selected={draft.selectedTier === o.tier}
          onSelect={() => update((d) => ({ ...d, selectedTier: o.tier }))}
          override={draft.overrides[o.tier] ?? null}
          onOverride={(ov) =>
            update((d) => {
              const overrides = { ...d.overrides };
              if (ov) overrides[o.tier] = ov;
              else delete overrides[o.tier];
              return { ...d, overrides };
            })
          }
          showCosts={showCosts}
          overrideLimit={profile.role === 'estimator' ? settings?.estimatorOverrideLimitPct ?? null : null}
        />
      ))}

      {bundle ? (
        <p className="px-1 text-xs text-slate-500">
          Pricing v{bundle.coefficientSet.version} · {bundle.hash.slice(0, 7)} · downloaded {new Date(bundle.builtAt).toLocaleString()}
        </p>
      ) : null}
    </>
  );
}

function OptionCard({
  option: o,
  selected,
  onSelect,
  override,
  onOverride,
  showCosts,
  overrideLimit,
}: {
  option: PricedOption;
  selected: boolean;
  onSelect: () => void;
  override: { price: number; reason: string } | null;
  onOverride: (o: { price: number; reason: string } | null) => void;
  showCosts: boolean;
  overrideLimit: number | null;
}) {
  const [editing, setEditing] = useState(false);
  const [price, setPrice] = useState<number | null>(override?.price ?? null);
  const [reason, setReason] = useState(override?.reason ?? '');
  const tier = o.tier as Tier;
  const deltaPct = override ? (override.price - o.modelPrice) / o.modelPrice : 0;

  return (
    <Card className={cx(selected && 'ring-2 ring-brand-600')}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">{TIER_LABELS[tier]}</p>
          <h3 className="font-semibold">{o.label}</h3>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold">{usd(o.price)}</p>
          {o.financing ? <p className="text-xs text-slate-500">or {usd(o.financing.monthly)}/mo</p> : null}
        </div>
      </div>

      <ul className="mt-3 space-y-1 text-sm">
        {o.customerItems.map((it, i) => (
          <li key={i} className="flex justify-between gap-3">
            <span className="text-slate-700">{it.description}</span>
          </li>
        ))}
      </ul>

      {o.isOverridden ? (
        <p className="mt-2 text-xs text-amber-800">
          Adjusted from {usd(o.modelPrice)} ({deltaPct >= 0 ? '+' : ''}
          {pct(deltaPct)}): {o.overrideReason}
        </p>
      ) : null}
      {o.belowFloor ? <Alert tone="red">Below the floor margin. Only the owner can send this price.</Alert> : null}

      {showCosts ? (
        <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-2 text-xs">
          <div>
            <dt className="text-slate-500">Cost (loaded)</dt>
            <dd className="font-semibold">{usd(o.loadedCost)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Margin</dt>
            <dd className={cx('font-semibold', o.belowFloor && 'text-red-700')}>{pct(o.marginPct)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Crew days</dt>
            <dd className="font-semibold">
              {num(o.crewDays, 1)} ({num(o.laborHours, 1)} h)
            </dd>
          </div>
        </dl>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onSelect}>
          {selected ? '★ Recommended' : 'Recommend this'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing((e) => !e)}>
          {override ? 'Edit price' : 'Adjust price'}
        </Button>
        {selected ? <Badge tone="green">Highlighted on the quote</Badge> : null}
      </div>

      {editing ? (
        <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3">
          <Field
            label="Customer price"
            hint={overrideLimit !== null ? `Estimators can move the price up to ${pct(overrideLimit, 0)} from ${usd(o.modelPrice)}.` : `Model price ${usd(o.modelPrice)}.`}
          >
            <NumberInput value={price} onValue={setPrice} />
          </Field>
          <Field label="Reason (required)">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. matched competitor quote" />
          </Field>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={!price || price <= 0 || reason.trim().length < 3}
              onClick={() => {
                onOverride({ price: price!, reason: reason.trim() });
                setEditing(false);
              }}
            >
              Apply
            </Button>
            {override ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  onOverride(null);
                  setPrice(null);
                  setReason('');
                  setEditing(false);
                }}
              >
                Use model price
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
