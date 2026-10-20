// Office views of a job: the signed option read from the frozen quote snapshot, and actuals vs
// the estimate per area x product. Office/owner only (it carries prices and costs). Pure.
import { z } from 'zod';
import { PRODUCTS, type ProductCode, type ProductUnit } from '@/lib/pricing';
import { naturalKey, PRODUCT_LABELS, PRODUCT_UNITS } from './crew';
import { variancePct } from './variance';

// ---------------------------------------------------------------------------
// Quote snapshot (quotes.snapshot, written at send time; older quotes may lack fields)
// ---------------------------------------------------------------------------

const finite = z.number().finite();
const snapshotLine = z.object({
  areaId: z.string().nullable().optional(),
  kind: z.string(),
  product: z.string().nullable().optional(),
  qty: finite.nullable().optional(),
  unit: z.string().nullable().optional(),
  hours: finite.nullable().optional(),
});
const snapshotSchema = z.object({
  document: z.object({ options: z.array(z.object({ tier: z.string(), label: z.string(), price: finite })).optional() }).optional(),
  options: z
    .array(z.object({ tier: z.string(), label: z.string().optional(), price: finite.optional(), crewDays: finite.optional(), lines: z.array(snapshotLine).optional() }))
    .optional(),
  input: z.object({ driveMinutesOneWay: finite.nullable().optional() }).optional(),
});
type Snapshot = z.infer<typeof snapshotSchema>;

function parseSnapshot(raw: unknown): Snapshot {
  const r = snapshotSchema.safeParse(raw);
  return r.success ? r.data : {};
}

export interface SignedOption {
  tier: string;
  label: string;
  /** What the customer signed for (quotes.signed_price), else the quoted price. */
  price: number | null;
}

/** The option the customer signed, as the quote showed it. */
export function signedOption(rawSnapshot: unknown, signedTier: string | null, signedPrice: number | null): SignedOption | null {
  if (!signedTier) return null;
  const s = parseSnapshot(rawSnapshot);
  const doc = s.document?.options?.find((o) => o.tier === signedTier);
  const priced = s.options?.find((o) => o.tier === signedTier);
  const label = doc?.label ?? priced?.label ?? signedTier[0]!.toUpperCase() + signedTier.slice(1);
  return { tier: signedTier, label, price: signedPrice ?? doc?.price ?? priced?.price ?? null };
}

// ---------------------------------------------------------------------------
// Actuals vs estimate
// ---------------------------------------------------------------------------

/** A job_actuals row as the office reads it (numbers already parsed). */
export interface OfficeActual {
  id: string;
  areaId: string | null;
  product: ProductCode | null;
  materialQty: number | null;
  materialUnit: ProductUnit | null;
  hours: number | null;
  crewSize: number | null;
  driveMinutes: number | null;
  days: number | null;
  materialCost: number | null;
  laborCost: number | null;
  otherCost: number | null;
  notes: string | null;
  enteredBy: string | null; // name
  enteredAt: string | null;
  verifiedBy: string | null; // name
  verifiedAt: string | null;
  excluded: boolean;
  excludeReason: string | null;
}

export interface CompareRow {
  key: string;
  areaId: string;
  areaName: string;
  product: ProductCode;
  label: string;
  unit: ProductUnit | null;
  hasMaterial: boolean;
  estQty: number | null;
  actualQty: number | null;
  qtyVariance: number | null;
  estHours: number | null;
  actualHours: number | null;
  hoursVariance: number | null;
  actual: OfficeActual | null;
  /** In the signed scope (false: an actuals row for something the quote did not include). */
  inScope: boolean;
}

export interface JobCompare {
  estDriveMinutes: number | null;
  actualDriveMinutes: number | null;
  driveVariance: number | null;
  estDays: number | null;
  actualDays: number | null;
  daysVariance: number | null;
  actualCrewSize: number | null;
  actual: OfficeActual | null;
}

const SCOPE_KINDS = new Set(['material', 'labor', 'removal']);
const isProduct = (p: unknown): p is ProductCode => typeof p === 'string' && (PRODUCTS as readonly string[]).includes(p);
const isUnit = (u: unknown): u is ProductUnit => typeof u === 'string' && (PRODUCT_UNITS as readonly string[]).includes(u);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Estimate vs actual for every area x product of the signed option (material line quantity,
 * labor or removal line hours), plus actuals rows outside that scope, in area order; and the
 * job-level drive minutes and days against the quote's inputs.
 */
export function compareActuals(args: {
  snapshot: unknown;
  signedTier: string | null;
  areas: ReadonlyArray<{ id: string; name: string }>;
  actuals: readonly OfficeActual[];
  driveMinutesEstFallback: number | null;
}): { rows: CompareRow[]; job: JobCompare } {
  const s = parseSnapshot(args.snapshot);
  const option = s.options?.find((o) => o.tier === args.signedTier);
  const areaIndex = new Map(args.areas.map((a, i) => [a.id, i]));
  const areaName = (id: string) => args.areas.find((a) => a.id === id)?.name ?? 'Unknown area';
  const actualByKey = new Map(args.actuals.map((a) => [naturalKey(a.areaId, a.product), a]));

  const rows = new Map<string, CompareRow>();
  const make = (areaId: string, product: ProductCode, inScope: boolean): CompareRow => {
    const key = naturalKey(areaId, product);
    let row = rows.get(key);
    if (!row) {
      row = {
        key,
        areaId,
        areaName: areaName(areaId),
        product,
        label: PRODUCT_LABELS[product],
        unit: null,
        hasMaterial: false,
        estQty: null,
        actualQty: null,
        qtyVariance: null,
        estHours: null,
        actualHours: null,
        hoursVariance: null,
        actual: null,
        inScope,
      };
      rows.set(key, row);
    }
    return row;
  };

  for (const l of option?.lines ?? []) {
    if (!l.areaId || !isProduct(l.product) || !SCOPE_KINDS.has(l.kind)) continue;
    const row = make(l.areaId, l.product, true);
    if (l.kind === 'material') {
      row.hasMaterial = true;
      if (isUnit(l.unit)) row.unit ??= l.unit;
      if (typeof l.qty === 'number') row.estQty = round2((row.estQty ?? 0) + l.qty);
    } else if (typeof l.hours === 'number') {
      row.estHours = round2((row.estHours ?? 0) + l.hours);
    }
  }
  for (const a of args.actuals) {
    if (a.areaId && a.product) make(a.areaId, a.product, false);
  }
  for (const row of rows.values()) {
    const a = actualByKey.get(row.key) ?? null;
    row.actual = a;
    row.actualQty = a?.materialQty ?? null;
    row.actualHours = a?.hours ?? null;
    if (!row.unit && a?.materialUnit) row.unit = a.materialUnit;
    if (a?.materialQty !== null && a?.materialQty !== undefined) row.hasMaterial = true;
    row.qtyVariance = variancePct(row.estQty, row.actualQty);
    row.hoursVariance = variancePct(row.estHours, row.actualHours);
  }

  const ordered = [...rows.values()].sort(
    (a, b) => (areaIndex.get(a.areaId) ?? Number.MAX_SAFE_INTEGER) - (areaIndex.get(b.areaId) ?? Number.MAX_SAFE_INTEGER) || Number(b.inScope) - Number(a.inScope),
  );

  const jobActual = actualByKey.get('job') ?? null;
  const estDrive = s.input?.driveMinutesOneWay ?? args.driveMinutesEstFallback;
  const estDays = option?.crewDays ?? null;
  return {
    rows: ordered,
    job: {
      estDriveMinutes: estDrive ?? null,
      actualDriveMinutes: jobActual?.driveMinutes ?? null,
      driveVariance: variancePct(estDrive, jobActual?.driveMinutes),
      estDays,
      actualDays: jobActual?.days ?? null,
      daysVariance: variancePct(estDays, jobActual?.days),
      actualCrewSize: jobActual?.crewSize ?? null,
      actual: jobActual,
    },
  };
}

/** Totals of the office-entered costs (null when none entered). */
export function costTotals(actuals: readonly OfficeActual[]): { material: number | null; labor: number | null; other: number | null; total: number | null } {
  const sum = (pick: (a: OfficeActual) => number | null) => {
    const xs = actuals.map(pick).filter((n): n is number => n !== null);
    return xs.length ? round2(xs.reduce((a, b) => a + b, 0)) : null;
  };
  const material = sum((a) => a.materialCost);
  const labor = sum((a) => a.laborCost);
  const other = sum((a) => a.otherCost);
  const parts = [material, labor, other].filter((n): n is number => n !== null);
  return { material, labor, other, total: parts.length ? round2(parts.reduce((a, b) => a + b, 0)) : null };
}
