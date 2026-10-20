// The offline estimate document. The phone edits this; the server stores it verbatim in
// estimates.client_doc and also normalizes it into relational tables for reporting/learning.
import { z } from 'zod';
import { ACCESS_LEVELS, JOB_TYPES, TIERS, type EstimateInput } from '@/lib/pricing';

export const ESTIMATE_STATUSES = ['draft', 'ready', 'sent', 'viewed', 'signed', 'lost', 'expired', 'void'] as const;

const trimmed = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable();
const positive = z.number().finite().positive();

export const areaSchema = z.object({
  id: z.uuid(),
  name: trimmed(80).min(1, 'Name the area'),
  jobType: z.enum(JOB_TYPES),
  sqft: positive.max(200_000),
  currentR: z.number().finite().min(0).max(100),
  targetR: z.number().finite().positive().max(100).nullable(),
  existingMaterial: optionalText(80),
  existingDepthIn: z.number().finite().min(0).max(60).nullable(),
  depthIn: z.number().finite().positive().max(60).nullable(),
  accessLevel: z.enum(ACCESS_LEVELS),
  removalNeeded: z.boolean(),
  prepNotes: optionalText(2000),
});

const overrideSchema = z.object({ price: positive.max(10_000_000), reason: trimmed(500) });

/** Estimator's own qty (material) or hours (labor/removal) for a line; keyed by lineKey(). */
export const lineOverrideSchema = z.object({
  qty: z.number().finite().min(0).max(1_000_000).nullable().optional(),
  hours: z.number().finite().min(0).max(10_000).nullable().optional(),
  reason: trimmed(500).min(3, 'Give a reason for the change'),
});

export const draftSchema = z.object({
  id: z.uuid(),
  status: z.enum(ESTIMATE_STATUSES),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  customer: z.object({
    id: z.uuid(),
    firstName: trimmed(80).min(1, 'First name is required'),
    lastName: trimmed(80).min(1, 'Last name is required'),
    email: z.union([z.email(), z.literal('')]).nullable(),
    phone: optionalText(30),
    smsConsent: z.boolean(),
    emailConsent: z.boolean(),
  }),
  property: z.object({
    id: z.uuid(),
    street: trimmed(120).min(1, 'Street is required'),
    city: trimmed(60).min(1, 'City is required'),
    state: trimmed(2).min(2),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, 'ZIP must be 5 digits'),
    yearBuilt: z.number().int().min(1700).max(2100).nullable(),
    utility: optionalText(60),
    homeType: optionalText(40),
  }),
  areas: z.array(areaSchema).max(30),
  crewId: z.uuid().nullable(),
  driveMinutesOneWay: z.number().finite().min(0).max(600).nullable(),
  overrides: z.partialRecord(z.enum(TIERS), overrideSchema),
  // Added in Phase 2; defaults keep older stored drafts valid.
  lineOverrides: z.record(z.string(), lineOverrideSchema).default({}),
  /** Estimator notes acknowledging deviation flags, keyed by DeviationFlag.key. */
  deviationAcks: z.record(z.string(), z.string().trim().max(500)).default({}),
  selectedTier: z.enum(TIERS).nullable(),
  notes: z.string().max(5000),
  rowVersion: z.number().int().positive().nullable(),
  bundleHash: z.string().nullable(),
  lastQuote: z
    .object({ quoteId: z.uuid(), version: z.number().int(), sentAt: z.iso.datetime() })
    .nullable()
    .optional(),
});

export type EstimateDraft = z.infer<typeof draftSchema>;
export type AreaDraft = z.infer<typeof areaSchema>;

/** A draft must have at least one area and a complete customer to be priced/synced. */
export const syncableDraftSchema = draftSchema.refine((d) => d.areas.length > 0, {
  message: 'Add at least one area',
  path: ['areas'],
});

export function newDraft(now = new Date(), uuid: () => string = () => crypto.randomUUID()): EstimateDraft {
  const ts = now.toISOString();
  return {
    id: uuid(),
    status: 'draft',
    createdAt: ts,
    updatedAt: ts,
    customer: { id: uuid(), firstName: '', lastName: '', email: '', phone: '', smsConsent: false, emailConsent: true },
    property: { id: uuid(), street: '', city: 'Newark', state: 'DE', zip: '', yearBuilt: null, utility: null, homeType: null },
    areas: [],
    crewId: null,
    driveMinutesOneWay: null,
    overrides: {},
    lineOverrides: {},
    deviationAcks: {},
    selectedTier: null,
    notes: '',
    rowVersion: null,
    bundleHash: null,
    lastQuote: null,
  };
}

export function newArea(jobType: AreaDraft['jobType'] = 'attic', uuid: () => string = () => crypto.randomUUID()): AreaDraft {
  const names: Record<AreaDraft['jobType'], string> = {
    attic: 'Attic',
    walls: 'Exterior walls',
    crawlspace: 'Crawlspace',
    rim_joist: 'Basement rim joist',
    garage: 'Garage',
    commercial: 'Commercial area',
  };
  return {
    id: uuid(),
    name: names[jobType],
    jobType,
    sqft: 0,
    currentR: 0,
    targetR: null,
    existingMaterial: null,
    existingDepthIn: null,
    depthIn: null,
    accessLevel: 'moderate',
    removalNeeded: false,
    prepNotes: null,
  };
}

export function toEstimateInput(d: EstimateDraft): EstimateInput {
  return {
    areas: d.areas,
    crewId: d.crewId,
    driveMinutesOneWay: d.driveMinutesOneWay,
    overrides: d.overrides,
    lineOverrides: d.lineOverrides,
  };
}

/** Areas that are complete enough to price (the editor may hold half-filled ones). */
export function priceableAreas(d: EstimateDraft): AreaDraft[] {
  return d.areas.filter((a) => areaSchema.safeParse(a).success);
}
