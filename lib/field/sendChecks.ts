// The Send checklist on the phone (L34, RF-02, UX-04): what must be true before a quote can go out,
// in plain words, one item per problem, each with a Fix button that opens the right place (or a
// Request approval for a price beyond the estimator's own range). It replaces the first schema
// message ("Too small: expected number to be >0") with the area or field it is about. Pure; the
// send route applies the same rules on the server (lib/pricing/policy). Nothing about a business
// profile is on it: there is no form to finish before sending (owner decision OD12).
import { canSendQuote, type PolicyProblem, type PriceApproval, type PricedOption, type PricingSettings, type Role, type Tier } from '@/lib/pricing';
import { latestByTier } from '@/lib/quotes/approvals';
import { syncBlocker } from '@/lib/offline/syncCore';
import { areaSchema, draftSchema, type AreaDraft, type EstimateDraft } from '@/lib/sync/draft';
import { JOB_TYPE_LABELS, num } from '@/lib/format';
import type { CustomerField, Fix } from './fix';
import { measurementChecks } from './measuring';

export interface SendCheckApproval {
  tier: Tier;
  price: number;
  modelPrice: number;
  belowFloor: boolean;
  /** Who may approve it: the owner only (below the floor margin), or the owner or the office. */
  approver: 'owner' | 'office';
  /** The newest request for this price: none yet, waiting, or declined (an approved one passes). */
  status: 'none' | 'pending' | 'declined';
  approvalId?: string;
  decisionNote?: string | null;
}

export interface SendCheck {
  id: string;
  ok: boolean;
  label: string;
  fix?: Fix;
  approval?: SendCheckApproval;
}

export interface SendCheckInput {
  draft: EstimateDraft;
  /** The options the customer would see, priced on this phone. */
  options: readonly PricedOption[];
  role: Role;
  settings: PricingSettings | null;
  /** This estimate's price approvals (empty offline or before any request). */
  approvals?: readonly PriceApproval[];
  /** Changes from the model still without a note. */
  pendingFlags: number;
  /** The phone has signal (navigator.onLine). */
  online: boolean;
  /** Koala answers (lib/offline/sync isReachable): signal alone is not enough to send (review B flow-B2). */
  reachable: boolean;
}

const TIER_WORDS: Record<Tier, string> = { good: 'Good', better: 'Better', best: 'Best' };
const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export function sendChecks(input: SendCheckInput): SendCheck[] {
  const { draft, options, role, settings, approvals = [], pendingFlags, online, reachable } = input;
  const checks: SendCheck[] = [...customerChecks(draft), ...areaChecks(draft)];

  const priceable = draft.areas.filter((a) => areaSchema.safeParse(a).success);
  if (priceable.length > 0) {
    checks.push(
      options.length
        ? { id: 'options', ok: true, label: `${options.length} ${options.length === 1 ? 'option' : 'options'} priced` }
        : {
            id: 'options',
            ok: false,
            label: 'None of the options can be offered for these areas.',
            fix: { label: 'Review options', target: { step: 'options' } },
          },
    );
  }

  // Anything else the draft still lacks (rare: a reason under 3 letters on a changed line, notes too long…).
  if (checks.every((c) => c.ok) && syncBlocker(draft)) checks.push(otherCheck(draft));

  checks.push(...priceChecks(role, options, settings, approvals));

  checks.push(
    pendingFlags > 0
      ? {
          id: 'flags',
          ok: false,
          label: `${pendingFlags} ${pendingFlags === 1 ? 'change from the model needs' : 'changes from the model need'} a short note.`,
          fix: { label: 'Explain', target: { step: 'options' } },
        }
      : { id: 'flags', ok: true, label: 'Every change from the model is explained' },
  );

  checks.push(
    !online
      ? { id: 'online', ok: false, label: 'Offline. Sending needs a connection; your work is saved.' }
      : !reachable
        ? { id: 'online', ok: false, label: "Can't reach Koala right now. Sending needs Koala; your work is saved." }
        : { id: 'online', ok: true, label: 'Online' },
  );
  return checks;
}

// ---------------------------------------------------------------------------
// Customer and address
// ---------------------------------------------------------------------------

function customerChecks(d: EstimateDraft): SendCheck[] {
  const c = d.customer;
  const out: SendCheck[] = [];
  const first = c.firstName.trim();
  const last = c.lastName.trim();
  out.push(
    first && last
      ? { id: 'name', ok: true, label: `Customer: ${first} ${last}` }
      : { id: 'name', ok: false, label: "Add the customer's name.", fix: { label: 'Add name', target: { step: 'customer', field: first ? 'lastName' : 'firstName' } } },
  );

  const email = (c.email ?? '').trim();
  if (!email) out.push({ id: 'email', ok: false, label: "Add the customer's email to send the quote.", fix: { label: 'Add email', target: { step: 'customer', field: 'email' } } });
  else if (!draftSchema.shape.customer.shape.email.safeParse(email).success)
    out.push({ id: 'email', ok: false, label: "The customer's email doesn't look right.", fix: { label: 'Fix email', target: { step: 'customer', field: 'email' } } });
  else out.push({ id: 'email', ok: true, label: `Email: ${email}` });

  const p = d.property;
  const shape = draftSchema.shape.property.shape;
  const missing: Array<{ field: CustomerField; words: string }> = [];
  if (!shape.street.safeParse(p.street).success) missing.push({ field: 'street', words: 'the street' });
  if (!shape.city.safeParse(p.city).success) missing.push({ field: 'city', words: 'the city' });
  if (!shape.state.safeParse(p.state).success) missing.push({ field: 'state', words: 'the state (two letters)' });
  if (!shape.zip.safeParse(p.zip).success) missing.push({ field: 'zip', words: 'a 5-digit ZIP code' });
  out.push(
    missing.length
      ? { id: 'address', ok: false, label: `Add ${list(missing.map((m) => m.words))} to the address.`, fix: { label: 'Add address', target: { step: 'customer', field: missing[0]!.field } } }
      : { id: 'address', ok: true, label: `Address: ${p.street.trim()}, ${p.city.trim()}, ${p.state.trim()} ${p.zip.trim()}` },
  );
  return out;
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

const AREA_FIELD_WORDS: Partial<Record<keyof AreaDraft, string>> = {
  currentR: 'the current R-value',
  targetR: 'the target R-value',
  existingDepthIn: 'the existing depth',
  depthIn: 'the cavity depth',
  existingMaterial: 'the existing insulation',
  prepNotes: 'the prep notes',
};

function areaChecks(d: EstimateDraft): SendCheck[] {
  if (d.areas.length === 0) return [{ id: 'areas', ok: false, label: 'Add an area to price.', fix: { label: 'Add an area', target: { step: 'areas' } } }];
  const measuring = new Map(measurementChecks(d).map((c) => [c.areaId, c]));
  return d.areas.map((a): SendCheck => {
    const id = `area:${a.id}`;
    const name = a.name.trim() || JOB_TYPE_LABELS[a.jobType];
    const r = areaSchema.safeParse(a);
    if (r.success) return { id, ok: true, label: `${name}: ${num(a.sqft, a.sqft < 10 ? 1 : 0)} sq ft` };
    const m = measuring.get(a.id);
    if (m) return { id, ok: false, label: m.label, fix: m.fix };
    const fields = new Set(r.error.issues.map((i) => i.path[0] as keyof AreaDraft));
    if (fields.has('name')) return { id, ok: false, label: `A ${JOB_TYPE_LABELS[a.jobType].toLowerCase()} area has no name. It is not in the price.`, fix: { label: 'Name it', target: { step: 'areas', areaId: a.id } } };
    if (fields.has('sqft')) {
      return a.sqft > 0
        ? { id, ok: false, label: `${name}: ${num(a.sqft)} sq ft is more than one area can be. It is not in the price.`, fix: { label: 'Check the size', target: { step: 'areas', areaId: a.id, open: 'size' } } }
        : { id, ok: false, label: `${name} has no size yet. It is not in the price.`, fix: { label: 'Add size', target: { step: 'areas', areaId: a.id, open: 'size' } } };
    }
    const words = [...fields].map((f) => AREA_FIELD_WORDS[f]).filter((w): w is string => !!w);
    return {
      id,
      ok: false,
      label: `${name}: check ${words.length ? list(words) : 'its details'}. It is not in the price.`,
      fix: { label: 'Open the area', target: { step: 'areas', areaId: a.id } },
    };
  });
}

/** Whatever else stops the draft from saving, sent to the step it is on. */
function otherCheck(d: EstimateDraft): SendCheck {
  const r = draftSchema.safeParse(d);
  const path = r.success ? [] : (r.error.issues[0]?.path ?? []);
  const top = String(path[0] ?? '');
  if (top === 'lineOverrides' || top === 'overrides' || top === 'deviationAcks' || top === 'driveMinutesOneWay')
    return { id: 'other', ok: false, label: 'A change on the Options step is not finished (a reason may be too short).', fix: { label: 'Open Options', target: { step: 'options' } } };
  if (top === 'notes') return { id: 'other', ok: false, label: 'The notes for the quote are too long.', fix: { label: 'Shorten the notes', target: { step: 'customer', field: 'notes' } } };
  return { id: 'other', ok: false, label: 'Something on this estimate is not finished.', fix: { label: 'Check the customer', target: { step: 'customer', field: 'firstName' } } };
}

// ---------------------------------------------------------------------------
// Prices: the role's limits and approvals
// ---------------------------------------------------------------------------

function priceChecks(role: Role, options: readonly PricedOption[], settings: PricingSettings | null, approvals: readonly PriceApproval[]): SendCheck[] {
  if (!settings || options.length === 0) return [];
  const policy = canSendQuote(role, [...options], settings, approvals);
  if (policy.ok) {
    const usedApproval = canSendQuote(role, [...options], settings).problems.some((p) => p.kind === 'below_floor' || p.kind === 'over_limit');
    return [{ id: 'price', ok: true, label: usedApproval ? 'Prices within your limits or approved' : 'Prices within your limits' }];
  }
  const current = Object.fromEntries(options.map((o) => [o.tier, { price: o.price, modelPrice: o.modelPrice, loadedCost: o.loadedCost }]));
  const latest = latestByTier(approvals, current);
  return policy.problems.map((p) => problemCheck(p, latest));
}

function problemCheck(p: PolicyProblem, latest: Partial<Record<Tier, PriceApproval>>): SendCheck {
  const tier = p.tier;
  if (p.kind === 'crew' || !tier) return { id: 'crew', ok: false, label: p.message };
  const name = TIER_WORDS[tier];
  if (p.kind === 'no_reason') return { id: `reason:${tier}`, ok: false, label: `${name}: give a reason for the new price.`, fix: { label: 'Add a reason', target: { step: 'options', tier } } };
  if (p.kind === 'line_no_reason') {
    return { id: `line:${tier}:${p.lineKey ?? p.line}`, ok: false, label: `${name}: give a reason for the change to "${p.line}".`, fix: { label: 'Add a reason', target: { step: 'options', tier } } };
  }
  const a = latest[tier];
  const status: SendCheckApproval['status'] = a?.status === 'pending' ? 'pending' : a?.status === 'declined' ? 'declined' : 'none';
  return {
    id: `price:${tier}`,
    ok: false,
    label: p.message,
    fix: { label: 'Change the price', target: { step: 'options', tier, edit: 'price' } },
    approval: {
      tier,
      price: p.price!,
      modelPrice: p.modelPrice!,
      belowFloor: p.kind === 'below_floor',
      approver: p.approver ?? 'owner',
      status,
      ...(a && status !== 'none' ? { approvalId: a.id, decisionNote: a.decisionNote ?? null } : {}),
    },
  };
}
