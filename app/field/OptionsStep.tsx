'use client';
import { useMemo, useState } from 'react';
import type { DeviationFlag, WinFeatures } from '@/lib/learning/types';
import { priceEstimate, type PricedOption, type PricingBundle, type Tier, type WinModel } from '@/lib/pricing';
import type { CachedProfile } from '@/lib/offline/db';
import { priceableAreas, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { ackState, ackSummary, flagsForOption, isAcknowledged, setDeviationAck } from '@/lib/field/flags';
import { applyLineOverride, formatPctDiff, relativeDiff, removeLineOverride, setPriceOverride, tiersWithLine } from '@/lib/field/lineOverrides';
import { beyondOverrideLimit, priceAdvice, recommendationReason, winFeaturesFor, type PriceAdvice } from '@/lib/field/priceAdvice';
import { recommendedTier } from '@/lib/field/recommended';
import { formatDateTime, formatMoney, num, pct, TIER_LABELS, usd } from '@/lib/format';
import { Alert, Badge, Button, Card, Field, Input, Select, cx } from '@/components/ui';
import { NumberInput } from '@/components/NumberInput';
import { Icon, Star } from '@/components/daymark';
import { DeviationNote } from './DeviationNote';
import { OptionLines, type OnAck, type OnLineOverride } from './OptionLines';
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
  editPrice = null,
}: {
  draft: EstimateDraft;
  update: Update;
  bundle: PricingBundle | null;
  priced: PricingResult;
  /** Deviation flags for the draft as priced on this phone (computed in EstimateEditor). */
  flags: DeviationFlag[];
  profile: CachedProfile;
  online: boolean;
  /** A "Change the price" Fix: this option's price editor opens, at Customer price (review B flow-B12). */
  editPrice?: Tier | null;
}) {
  const settings = bundle?.snapshot.settings;
  const showCosts = profile.role !== 'estimator' || !!settings?.estimatorsSeeCosts;
  const overrideLimit = profile.role === 'estimator' ? (settings?.estimatorOverrideLimitPct ?? null) : null;
  const [lookup, setLookup] = useState<{ busy: boolean; msg: string | null }>({ busy: false, msg: null });

  // Bundles cached by the Phase 1 app have no winModel field at all.
  const winModel = bundle?.winModel ?? null;
  const features = winModel ? winFeaturesFor(priceableAreas(draft)) : null;
  const options = priced?.ok?.options ?? [];
  // Options the customer is not shown (OD6) stay on this step, collapsed, with the reason: a price
  // or line change that hid one can be changed or removed here (review A F1, M2).
  const hidden = useMemo(() => (priced?.ok ? notShown(draft, bundle, priced.ok.options) : []), [draft, bundle, priced]);
  const hiddenReason = (tier: Tier) =>
    priced?.ok?.warnings.find((w) => w.code === 'option_hidden' && w.tier === tier)?.message ?? 'This option is not shown to the customer.';
  // The same option the dock and the customer quote mark as recommended.
  const recommended = recommendedTier(options, draft.selectedTier);
  const areaNames = new Map(draft.areas.map((a) => [a.id, a.name]));
  const toExplain = ackSummary(flags, draft.deviationAcks).pending;

  const onAck: OnAck = (flag, note) => update((d) => setDeviationAck(d, flag, note));
  const onLineOverride: OnLineOverride = (key, ov) => update((d) => (ov ? applyLineOverride(d, key, ov) : removeLineOverride(d, key)));
  // A line change applies to every option with that line, shown or not.
  const tiersByKey = (key: string) => tiersWithLine(byTier([...options, ...hidden]), key);

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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      {/* Why an option is not shown is said on its own card below. */}
      {priced?.ok?.warnings
        .filter((w) => !(w.code === 'option_hidden' && hidden.some((o) => o.tier === w.tier)))
        .map((w, i) => (
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
            recommended={recommended?.tier === o.tier ? (recommended.picked ? 'picked' : draft.selectedTier ? 'moved' : 'default') : null}
            onSelect={() => update((d) => ({ ...d, selectedTier: o.tier }))}
            override={draft.overrides[o.tier] ?? null}
            onOverride={(ov) => update((d) => setPriceOverride(d, o.tier, ov))}
            showCosts={showCosts}
            overrideLimit={overrideLimit}
            flags={flags}
            acks={draft.deviationAcks}
            onAck={onAck}
            onLineOverride={onLineOverride}
            areaNames={areaNames}
            tiersByKey={tiersByKey}
            advice={advice && winModel ? { advice, model: winModel } : null}
            startEditing={editPrice === o.tier}
          />
        );
      })}

      {hidden.length > 0 ? (
        <>
          <h3 className="px-1 pt-2 text-sm font-semibold text-slate-600">Not shown to the customer</h3>
          {hidden.map((o) => (
            <OptionCard
              key={o.tier}
              option={o}
              hiddenReason={hiddenReason(o.tier)}
              recommended={null}
              onSelect={() => {}}
              override={draft.overrides[o.tier] ?? null}
              onOverride={(ov) => update((d) => setPriceOverride(d, o.tier, ov))}
              showCosts={showCosts}
              overrideLimit={overrideLimit}
              flags={flags}
              acks={draft.deviationAcks}
              onAck={onAck}
              onLineOverride={onLineOverride}
              areaNames={areaNames}
              tiersByKey={tiersByKey}
              advice={null}
              startEditing={editPrice === o.tier}
            />
          ))}
        </>
      ) : null}

      {options.length > 0 && bundle && !winModel ? (
        <p className="px-1 text-xs text-slate-500">Price recommendations start once enough quotes have been won or lost.</p>
      ) : null}

      {bundle ? (
        <p className="px-1 text-xs text-slate-500">
          Pricing v{bundle.coefficientSet.version} · {bundle.hash.slice(0, 7)} · downloaded {formatDateTime(bundle.builtAt)}
        </p>
      ) : null}
    </>
  );
}

const TIER_ORDER: Tier[] = ['good', 'better', 'best'];
const byTier = (xs: PricedOption[]) => [...xs].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));

/**
 * The options priced but not shown to the customer (OD6), in tier order: every option priced with
 * showAll, less those shown. Never breaks the step: with no bundle or a pricing error, none.
 */
function notShown(draft: EstimateDraft, bundle: PricingBundle | null, shown: PricedOption[]): PricedOption[] {
  if (!bundle) return [];
  try {
    const all = priceEstimate({ ...toEstimateInput(draft), areas: priceableAreas(draft) }, bundle.snapshot, bundle.coefficientSet, { showAll: true });
    const tiers = new Set(shown.map((o) => o.tier));
    return all.options.filter((o) => !tiers.has(o.tier));
  } catch {
    return [];
  }
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
  hiddenReason = null,
  recommended,
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
  startEditing = false,
}: {
  option: PricedOption;
  /**
   * Why the customer is not shown this option (OD6). The card is then collapsed: its title, price
   * and the reason, with Change price, Remove price change and Details, and no Make recommended.
   */
  hiddenReason?: string | null;
  /**
   * This card is the recommended option, the one the quote highlights (lib/field/recommended.ts):
   * picked by the estimator, the default (Better, else the first shown), or 'moved' when the
   * estimator's pick is not shown (OD6) and the recommendation moved to this option.
   */
  recommended: 'picked' | 'default' | 'moved' | null;
  onSelect: () => void;
  override: { price: number; reason: string } | null;
  onOverride: (o: { price: number; reason: string } | null) => void;
  showCosts: boolean;
  overrideLimit: number | null;
  flags: DeviationFlag[];
  acks: EstimateDraft['deviationAcks'];
  onAck: OnAck;
  onLineOverride: OnLineOverride;
  areaNames: Map<string, string>;
  tiersByKey: (key: string) => Tier[];
  advice: { advice: PriceAdvice; model: WinModel } | null;
  /** Open with the price editor showing (a "Change the price" Fix; EstimateEditor then focuses Customer price). */
  startEditing?: boolean;
}) {
  const mine = flagsForOption(flags, o);
  const linesToExplain = [...mine.byLine.values()].flat().filter((f) => !isAcknowledged(f, acks)).length;
  const [editing, setEditing] = useState(startEditing);
  // Open the line details when a change on one of them still needs explaining.
  const [details, setDetails] = useState(linesToExplain > 0);
  const [price, setPrice] = useState<number | null>(override?.price ?? null);
  const [reason, setReason] = useState(override?.reason ?? '');
  const tier = o.tier as Tier;
  const deltaPct = override && o.modelPrice > 0 ? (override.price - o.modelPrice) / o.modelPrice : 0;

  const limitNote =
    advice && beyondOverrideLimit(advice.advice.best.price, o.modelPrice, overrideLimit)
      ? `This is more than ${pct(overrideLimit ?? 0, 0)} from the model price (${usd(o.modelPrice)}), so it needs approval from the owner or the office before you can send it (Request approval on the Send step).`
      : null;

  const priceEditor = editing ? (
    <div className="mt-3 space-y-3 rounded-xl bg-slate-50 p-3">
      <Field
        label="Customer price"
        hint={overrideLimit !== null ? `Estimators can move the price up to ${pct(overrideLimit, 0)} from ${usd(o.modelPrice)}.` : `Model price ${usd(o.modelPrice)}.`}
      >
        <NumberInput id={`option-${tier}-price`} value={price} onValue={setPrice} allowDecimal={false} />
      </Field>
      {price !== null && price < 1 ? <p className="text-xs text-amber-800">Enter a price of $1 or more.</p> : null}
      <Field label="Reason (required)">
        <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="e.g. matched competitor quote" />
      </Field>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={price === null || price < 1 || reason.trim().length < 3}
          onClick={() => {
            // Prices are whole dollars (the engine rounds the same way).
            onOverride({ price: Math.round(price!), reason: reason.trim() });
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
  ) : null;
  const lineDetails = details ? (
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
  ) : null;
  const changePrice = (
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
      Change price
    </Button>
  );
  const detailsButton = (
    <Button size="sm" variant="ghost" onClick={() => setDetails((v) => !v)} aria-expanded={details}>
      {details ? 'Hide details' : 'Details'}
      {linesToExplain > 0 ? <Badge tone="amber">{linesToExplain} to explain</Badge> : null}
    </Button>
  );

  if (hiddenReason !== null) {
    return (
      <div role="group" id={`option-${tier}`} aria-label={`${TIER_LABELS[tier]} option`}>
        <Card className="border-dashed bg-slate-50">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{TIER_LABELS[tier]}</p>
              <h3 className="font-semibold text-slate-700">{o.label}</h3>
            </div>
            <p className="shrink-0 text-lg font-semibold text-slate-500 tabular-nums">{usd(o.price)}</p>
          </div>
          <div className="mt-2">
            <Badge tone="amber">Not shown to the customer</Badge>
          </div>
          <p className="mt-2 text-sm text-slate-700">{hiddenReason}</p>
          {override ? (
            <p className="mt-1 text-xs text-amber-800">
              Your price {usd(override.price)} (model {usd(o.modelPrice)}): {override.reason}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {changePrice}
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
                Remove price change
              </Button>
            ) : null}
            {detailsButton}
          </div>
          {priceEditor}
          {lineDetails}
        </Card>
      </div>
    );
  }

  return (
    <div role="group" id={`option-${tier}`} aria-label={`${TIER_LABELS[tier]} option`}>
      <Card className={cx(recommended && 'ring-2 ring-brand-600')}>
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

        {/* What the customer's quote lists: each piece of work at its own price (the same in every
            option), then travel and setup, any minimum job charge and any price change. They add up
            to the price above. */}
        <ul className="mt-3 space-y-1 text-sm" aria-label="What the price is made of">
          {o.customerItems.map((it, i) => (
            <li key={i} className="flex justify-between gap-3">
              <span className={it.kind === 'work' ? 'text-slate-700' : 'text-slate-500'}>
                {/* In a package, the area each line prices, as the customer's quote names it (release review C FLOW-12). */}
                {areaNames.size > 1 && it.areaName ? <span className="block text-xs font-semibold tracking-wide text-slate-500 uppercase">{it.areaName}</span> : null}
                {it.description}
              </span>
              <span className="shrink-0 font-medium text-slate-700 tabular-nums">{formatMoney(it.price, { cents: 'never' })}</span>
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
        {o.belowFloor ? <Alert tone="red">Below the floor margin. Only the owner can send this price or approve it.</Alert> : null}

        {mine.total.map((f) => (
          <div key={f.key} className="mt-2">
            <DeviationNote flag={f} ack={ackState(f, acks)} onNote={(note) => onAck(f, note)} />
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
          {/* The recommended card says so; tapping it keeps it recommended. Others offer the action. */}
          <Button size="sm" variant={recommended ? 'primary' : 'secondary'} onClick={onSelect}>
            {recommended ? (
              <>
                <Icon icon={Star} size="s" className={cx(recommended === 'picked' && 'fill-current')} />
                {recommended === 'picked' ? 'Recommended' : recommended === 'moved' ? 'Recommended (your pick is not shown)' : 'Recommended (default)'}
              </>
            ) : (
              'Make recommended'
            )}
          </Button>
          {changePrice}
          {detailsButton}
          {/* The quote highlights the same recommended option (lib/quotes/model.ts, recommendedTier). */}
          {recommended ? <Badge tone="green">Highlighted on the quote</Badge> : null}
        </div>

        {priceEditor}
        {lineDetails}
      </Card>
    </div>
  );
}
