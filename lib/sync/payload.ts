// Converts an offline draft + its priced result into the snake_case payload consumed by
// the sync_upsert_estimate() Postgres function. Pure, so it is unit tested.
import type { PricedEstimate, PricingBundle } from '@/lib/pricing';
import type { DeviationFlag } from '@/lib/learning/types';
import { acknowledgedNote } from '@/lib/field/flags';
import { priceableAreas, type EstimateDraft } from './draft';

export interface SyncPayload {
  estimate: Record<string, unknown>;
  customer: Record<string, unknown>;
  property: Record<string, unknown>;
  areas: Array<Record<string, unknown>>;
  options: Array<Record<string, unknown> & { lines: Array<Record<string, unknown>> }>;
  flags: Array<Record<string, unknown>>;
}

export function buildSyncPayload(
  draft: EstimateDraft,
  priced: PricedEstimate,
  bundle: PricingBundle,
  opts: { pricedOffline: boolean; uuid?: () => string; flags?: DeviationFlag[] },
): SyncPayload {
  const uuid = opts.uuid ?? (() => crypto.randomUUID());
  const selected = priced.options.find((o) => o.tier === draft.selectedTier) ?? priced.options[0] ?? null;
  // Server-only statuses (sent/viewed/signed/...) are never set by the client.
  const status = draft.status === 'ready' ? 'ready' : 'draft';

  return {
    estimate: {
      id: draft.id,
      status,
      coefficient_set_id: bundle.coefficientSet.id,
      pricing_snapshot: bundle.snapshot,
      pricing_snapshot_hash: bundle.hash,
      drive_minutes_est: draft.driveMinutesOneWay,
      crew_id: priced.crewId,
      selected_tier: draft.selectedTier,
      model_total_price: selected?.modelPrice ?? null,
      notes: draft.notes || null,
      priced_offline: opts.pricedOffline,
      client_created_at: draft.createdAt,
      client_doc: { ...draft, status, bundleHash: bundle.hash },
    },
    customer: {
      id: draft.customer.id,
      first_name: draft.customer.firstName,
      last_name: draft.customer.lastName,
      email: draft.customer.email || null,
      phone: draft.customer.phone || null,
      sms_consent: draft.customer.smsConsent,
      email_consent: draft.customer.emailConsent,
    },
    property: {
      id: draft.property.id,
      street: draft.property.street,
      city: draft.property.city,
      state: draft.property.state,
      zip: draft.property.zip,
      year_built: draft.property.yearBuilt,
      utility: draft.property.utility,
      home_type: draft.property.homeType,
    },
    // Only complete areas go to relational tables; half-filled ones live in client_doc.
    areas: priceableAreas(draft).map((a, i) => ({
      id: a.id,
      name: a.name,
      job_type: a.jobType,
      sqft: a.sqft,
      current_r: a.currentR,
      target_r: a.targetR,
      existing_material: a.existingMaterial,
      existing_depth_in: a.existingDepthIn,
      depth_in: a.depthIn,
      access_level: a.accessLevel,
      removal_needed: a.removalNeeded,
      prep_notes: a.prepNotes,
      sort_order: i,
    })),
    options: priced.options.map((o) => {
      const optionId = uuid();
      return {
        id: optionId,
        tier: o.tier,
        label: o.label,
        direct_cost: o.directCost,
        loaded_cost: o.loadedCost,
        price: o.price,
        model_price: o.modelPrice,
        is_overridden: o.isOverridden,
        override_reason: o.overrideReason,
        margin_pct: o.marginPct,
        crew_days: o.crewDays,
        financing: o.financing,
        lines: o.lines.map((l, i) => ({
          id: uuid(),
          option_id: optionId,
          area_id: l.areaId,
          kind: l.kind,
          product: l.product,
          material_id: l.materialId,
          description: l.description,
          qty: l.qty,
          unit: l.unit,
          hours: l.hours,
          unit_cost: l.unitCost,
          cost: l.cost,
          design_qty: l.designQty,
          model_qty: l.modelQty,
          model_hours: l.modelHours,
          model_cost: l.modelCost,
          is_overridden: l.isOverridden,
          override_reason: l.overrideReason,
          line_key: l.key,
          sort_order: i,
        })),
      };
    }),
    flags: (opts.flags ?? []).map((f) => ({
      flag_key: f.key,
      tier: f.tier,
      line_key: f.lineKey,
      metric: f.metric,
      estimator_value: f.estimatorValue,
      model_value: f.modelValue,
      pct_diff: f.pctDiff,
      reasons: f.reasons,
      // The note string, only while it explains this deviation (never a stale one).
      ack_note: acknowledgedNote(f, draft.deviationAcks),
    })),
  };
}
