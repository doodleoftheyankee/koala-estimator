'use client';
import { useState } from 'react';
import type { DeviationFlag, WinFeatures } from '@/lib/learning/types';
import type { PricedOption, PricingBundle, Tier, WinModel } from '@/lib/pricing';
import type { CachedProfile } from '@/lib/offline/db';
import { priceableAreas, type EstimateDraft } from '@/lib/sync/draft';
import { ackNote, ackSummary, flagsForOption, setDeviationAck } from '@/lib/field/flags';
import { applyLineOverride, formatPctDiff, relativeDiff, removeLineOverride, tiersWithLine } from '@/lib/field/lineOverrides';
import { beyondOverrideLimit, priceAdvice, recommendationReason, winFeaturesFor, type PriceAdvice } from '@/lib/field/priceAdvice';
import { num, pct, TIER_LABELS, usd } from '@/lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select, cx } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import { DeviationNote } from './DeviationNote';
import { OptionLines, type OnLineOverride } from './OptionLines';
import { PriceAdvicePanel } from './PriceAdvicePanel';
import type { PricingResult, Update } from './EstimateEditor';

type Settings = PricingBundle['snapshot']['settings'];

export function OptionsStep({
  draft,
  update,
  bundle,
  priced,
  flags,
  profile,
  online,
}: {
  draft: EstimateDraft;
  update: Update;
  bundle: PricingBundle | null;
  priced: PricingResult;
  /** Deviation flags for the draft as priced on this phone (computed in EstimateEditor). */
  flags: DeviationFlag[];
  profile: CachedProfile;
  online: boolean;
}) {
  const settings = bundle?.snapshot.settings;
  const showCosts = profile.role !== 'estimator' || !!settings?.estimatorsSeeCosts;
  const overrideLimit = profile.role === 'estimator' ? (settings?.estimatorOverrideLimitPct ?? null) : null;
  const [lookup, setLookup] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });

  // Bundles cached by the Phase 1 app have no winModel field at all.
  const winModel = bundle?.winModel ?? null;
  const features = winModel ? winFeaturesFor(priceableAreas(draft)) : null;
  const options = priced?.ok?.options ?? [];
  const areaNames = new Map(draft.areas.map((a) => [a.id, a.name]));
  const toExplain = ackSummary(flags, draft.deviationAcks).pending;

  const onAck = (key: string, note: string) => update((d) => setDeviationAck(d, key, note));
  const onLineOverride: OnLineOverride = (key, ov) => update((d) => (ov ? applyLineOverride(d, key, ov) : removeLineOverride(d, key)));
  const tiersByKey = (key: string) => tiersWithLine(options, key);

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

      {toExplain > 0 ? (
        <Alert tone="amber">
          {toExplain === 1 ? '1 change from the model needs' : `${toExplain} changes from the model need`} a short explanation before you can send.
          They are marked below.
        </Alert>
      ) : null}

      {options.map((o) => {
        const advice = winModel && features && settings ? adviceFor(winModel, o, features, settings) : null;
        return (
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
            overrideLimit={overrideLimit}
            flags={flags}
            acks={draft.deviationAcks}
            onAck={onAck}
            onLineOverride={onLineOverride}
            areaNames={areaNames}
            tiersByKey={tiersByKey}
            advice={advice && winModel ? { advice, model: winModel } : null}
          />
        );
      })}

      {options.length > 0 && bundle && !winModel ? (
        <p className="px-1 text-xs text-slate-500">Price recommendations start once enough quotes have been won or lost.</p>
      ) : null}

      {bundle ? (
        <p className="px-1 text-xs text-slate-500">
          Pricing v{bundle.coefficientSet.version} · {bundle.hash.slice(0, 7)} · downloaded {new Date(bundle.builtAt).toLocaleString()}
        </p>
      ) : null}
    </>
  );
}

/** Advice is a nice-to-have: a bad cached model must never break the Options step. */
function adviceFor(model: WinModel, option: PricedOption, features: Omit<WinFeatures, 'markup'>, settings: Settings): PriceAdvice | null {
  try {
    return priceAdvice(model, option, features, settings);
  } catch {
    return null;
  }
}

function OptionCard({
  option: o,
  selected,
  onSelect,
  override,
  onOverride,
  showCosts,
  overrideLimit,
  flags,
  acks,
  onAck,
  onLineOverride,
  areaNames,
  tiersByKey,
  advice,
}: {
  option: PricedOption;
  selected: boolean;
  onSelect: () => void;
  override: { price: number; reason: string } | null;
  onOverride: (o: { price: number; reason: string } | null) => void;
  showCosts: boolean;
  overrideLimit: number | null;
  flags: DeviationFlag[];
  acks: Record<string, string>;
  onAck: (key: string, note: string) => void;
  onLineOverride: OnLineOverride;
  areaNames: Map<string, string>;
  tiersByKey: (key: string) => Tier[];
  advice: { advice: PriceAdvice; model: WinModel } | null;
}) {
  const mine = flagsForOption(flags, o);
  const linesToExplain = [...mine.byLine.values()].flat().filter((f) => !ackNote(acks, f.key).trim()).length;
  const [editing, setEditing] = useState(false);
  // Open the line details when a change on one of them still needs explaining.
  const [details, setDetails] = useState(linesToExplain > 0);
  const [price, setPrice] = useState<number | null>(override?.price ?? null);
  const [reason, setReason] = useState(override?.reason ?? '');
  const tier = o.tier as Tier;
  const deltaPct = override && o.modelPrice > 0 ? (override.price - o.modelPrice) / o.modelPrice : 0;

  const limitNote =
    advice && beyondOverrideLimit(advice.advice.best.price, o.modelPrice, overrideLimit)
      ? `This is more than ${pct(overrideLimit ?? 0, 0)} from the model price (${usd(o.modelPrice)}), so the office would need to send it.`
      : null;

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

      {o.hasLineOverrides ? (
        <p className="mt-2 text-xs text-amber-800">
          Your line changes move the model price {usd(o.modelPrice)} to {usd(o.adjustedPrice)} ({formatPctDiff(relativeDiff(o.adjustedPrice, o.modelPrice))}).
        </p>
      ) : null}
      {o.isOverridden ? (
        <p className="mt-2 text-xs text-amber-800">
          Adjusted from {usd(o.modelPrice)} ({deltaPct >= 0 ? '+' : ''}
          {pct(deltaPct)}): {o.overrideReason}
        </p>
      ) : null}
      {o.belowFloor ? <Alert tone="red">Below the floor margin. Only the owner can send this price.</Alert> : null}

      {mine.total.map((f) => (
        <div key={f.key} className="mt-2">
          <DeviationNote flag={f} note={ackNote(acks, f.key)} onNote={(note) => onAck(f.key, note)} />
        </div>
      ))}

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

      {advice ? (
        <PriceAdvicePanel
          advice={advice.advice}
          nQuotes={advice.model.nQuotes}
          showCosts={showCosts}
          limitNote={limitNote}
          onUse={() => onOverride({ price: advice.advice.best.price, reason: recommendationReason(advice.model) })}
        />
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant={selected ? 'primary' : 'secondary'} onClick={onSelect}>
          {selected ? '★ Recommended' : 'Recommend this'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            // Start from the saved override: it may have changed since (e.g. "Use this price").
            if (!editing) {
              setPrice(override?.price ?? null);
              setReason(override?.reason ?? '');
            }
            setEditing((e) => !e);
          }}
        >
          {override ? 'Edit price' : 'Adjust price'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
          {details ? 'Hide details' : 'Details'}
          {linesToExplain > 0 ? <Badge tone="amber">{linesToExplain} to explain</Badge> : null}
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
            <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. matched competitor quote" />
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

      {details ? (
        <OptionLines
          tier={o.tier}
          lines={o.lines}
          areaNames={areaNames}
          tiersByKey={tiersByKey}
          flagsByLine={mine.byLine}
          acks={acks}
          onAck={onAck}
          onLineOverride={onLineOverride}
          showCosts={showCosts}
        />
      ) : null}
    </Card>
  );
}
