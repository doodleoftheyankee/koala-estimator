// The blower door tool's franchise settings (app_settings.blower_door, snake_case JSON): the
// rebate programs the franchise works with, the gauge it tests with and the defaults for the flow
// exponent and the zone N-factor. Nothing about any one program lives in code: each franchise
// enters its own programs on the Rebate programs page (app/admin/rebates). Pure.
//
// Two readers:
//   parseBlowerDoorSettings  lenient, for the tool: anything missing or out of range falls back to
//                            a default and a program that does not make sense is left out (and
//                            named in `problems`), so the tool always opens.
//   validateBlowerDoorSettings  strict, for saving: every rule the editor enforces, with readable
//                            messages, returning the JSON to store.
import { z } from 'zod';
import { hasAtMostDecimals } from './numbers';

export interface RebateTier {
  /** Reduction in CFM50 the tier needs, in percent (20 = 20%). */
  reductionPct: number;
  /** What the tier pays, whole dollars. */
  rebate: number;
}

export interface RebateProgram {
  /** Stable id, kept with every saved reading. */
  key: string;
  /** The full name, for the copied summary ("Sponsor Program Name"). */
  name: string;
  /** The short name on the program buttons. */
  label: string;
  /** Ascending by reductionPct. */
  tiers: RebateTier[];
  /** The air sealing rebate is at most this % of the installed air sealing price (null: no cap). */
  costCapPct: number | null;
  /** The program's mechanical ventilation rebate, up to this many dollars (null: none). */
  mechVentRebateCap: number | null;
  /** Where the tier amounts come from ("the sponsor's rebate schedule"). */
  source: string;
  /** When the tier amounts took effect, YYYY-MM-DD. */
  effectiveDate: string | null;
  /** What the program needs with the test-out. */
  paperwork: string[];
  /** Where the paperwork list comes from. */
  paperworkSource: string;
}

export interface BlowerDoorSettings {
  /** The gauge the franchise tests with, named in the summary. */
  gauge: string;
  /** Default flow exponent n (the gauge's house setting). */
  flowExponent: number;
  /** Default zone N-factor for the BAS estimate. */
  nFactor: number;
  /**
   * Decide the tier and the ventilation lines on CFM50 rounded once to whole numbers, as the
   * gauge's @50 screen and a program's test-out form carry them. False (the default): on the exact
   * converted CFM50. Which one a program uses is the owner's call (Rebate programs page).
   */
  wholeCfm50: boolean;
  programs: RebateProgram[];
}

/** The app_settings key. */
export const SETTINGS_KEY = 'blower_door';

export const DEFAULT_GAUGE = 'Retrotec Model 5000';
export const DEFAULT_EXPONENT = 0.65;
/** BPI's Zone 2 example value (Zone 2 runs 17–20). */
export const DEFAULT_N_FACTOR = 19;

export const LIMITS = {
  programs: 10,
  tiers: 10,
  paperwork: 15,
  gauge: 80,
  name: 120,
  label: 40,
  source: 200,
  paperworkItem: 300,
  exponent: { min: 0.5, max: 1 },
  nFactor: { min: 1, max: 40 },
  rebate: 100_000,
} as const;

/** Settings for a franchise that has not set any programs up. */
export const EMPTY_SETTINGS: BlowerDoorSettings = { gauge: DEFAULT_GAUGE, flowExponent: DEFAULT_EXPONENT, nFactor: DEFAULT_N_FACTOR, wholeCfm50: false, programs: [] };

// ---------------------------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------------------------

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
export function isYmd(s: string): boolean {
  const m = YMD.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

const KEY = /^[a-z0-9][a-z0-9_-]{0,39}$/;

const text = (label: string, max: number) =>
  z
    .string({ error: `${label} is missing.` })
    .transform((s) => s.replace(/\s+/g, ' ').trim())
    .pipe(z.string().min(1, `${label} is missing.`).max(max, `${label} is too long (at most ${max} characters).`));
const optionalText = (label: string, max: number) =>
  z
    .string()
    .nullable()
    .default(null)
    .transform((s) => (s ?? '').replace(/\s+/g, ' ').trim())
    .pipe(z.string().max(max, `${label} is too long (at most ${max} characters).`));

const wholeDollars = (label: string) =>
  z
    .number({ error: `${label} must be a number of dollars.` })
    .int(`${label} must be whole dollars (no cents).`)
    .min(0, `${label} cannot be negative.`)
    .max(LIMITS.rebate, `${label} must be at most $${LIMITS.rebate.toLocaleString('en-US')}.`);

/** One program, strictly. `n` names it in messages ("Program 2"). */
function programSchema(n: string) {
  return z
    .object({
      key: z.string().regex(KEY, `${n}: its key must be lower-case letters, digits, - or _.`),
      name: text(`${n}: the full name`, LIMITS.name),
      label: text(`${n}: the short name`, LIMITS.label),
      tiers: z
        .array(
          z.object({
            reduction_pct: z
              .number({ error: `${n}: each tier needs a reduction percent.` })
              .gt(0, `${n}: a tier's reduction must be more than 0%.`)
              .lt(100, `${n}: a tier's reduction must be less than 100%.`),
            rebate: wholeDollars(`${n}: a tier's rebate`),
          }),
        )
        .min(1, `${n}: add at least one tier.`)
        .max(LIMITS.tiers, `${n}: at most ${LIMITS.tiers} tiers.`),
      cost_cap_pct: z
        .number({ error: `${n}: the cost cap must be a percent.` })
        .gt(0, `${n}: the cost cap must be more than 0%.`)
        .max(100, `${n}: the cost cap must be at most 100%.`)
        .nullable()
        .default(null),
      mech_vent_rebate_cap: wholeDollars(`${n}: the ventilation rebate`).nullable().default(null),
      source: optionalText(`${n}: the source`, LIMITS.source),
      effective_date: z
        .string()
        .nullable()
        .default(null)
        .transform((s) => (s === null || s.trim() === '' ? null : s.trim()))
        .refine((s) => s === null || isYmd(s), `${n}: the effective date must be a real date.`),
      paperwork: z
        .array(text(`${n}: a paperwork item`, LIMITS.paperworkItem))
        .max(LIMITS.paperwork, `${n}: at most ${LIMITS.paperwork} paperwork items.`)
        .default([]),
      paperwork_source: optionalText(`${n}: the paperwork source`, LIMITS.source),
    })
    .superRefine((p, ctx) => {
      for (let i = 1; i < p.tiers.length; i++) {
        const [a, b] = [p.tiers[i - 1]!, p.tiers[i]!];
        if (!(b.reduction_pct > a.reduction_pct)) {
          ctx.addIssue({ code: 'custom', message: `${n}: tiers must go up in reduction, lowest first (${a.reduction_pct}% then ${b.reduction_pct}%).` });
        } else if (b.rebate < a.rebate) {
          ctx.addIssue({ code: 'custom', message: `${n}: a higher tier cannot pay less than a lower one ($${a.rebate} then $${b.rebate}).` });
        }
      }
    });
}

export type StoredProgram = z.output<ReturnType<typeof programSchema>>;
export interface StoredSettings {
  gauge: string;
  flow_exponent: number;
  n_factor: number;
  /** Stored only when on (older settings do not have it). */
  whole_cfm50?: boolean;
  programs: StoredProgram[];
}

const settingsSchema = z
  .object({
    gauge: text('The gauge name', LIMITS.gauge),
    flow_exponent: z
      .number({ error: 'The flow exponent must be a number.' })
      .min(LIMITS.exponent.min, `The flow exponent must be between ${LIMITS.exponent.min} and ${LIMITS.exponent.max}.`)
      .max(LIMITS.exponent.max, `The flow exponent must be between ${LIMITS.exponent.min} and ${LIMITS.exponent.max}.`)
      // A saved reading keeps 3 decimals of n (numeric(4,3)).
      .refine((n) => hasAtMostDecimals(n, 3), 'The flow exponent can have at most 3 decimals.'),
    n_factor: z
      .number({ error: 'The N-factor must be a number.' })
      .min(LIMITS.nFactor.min, `The N-factor must be between ${LIMITS.nFactor.min} and ${LIMITS.nFactor.max}.`)
      .max(LIMITS.nFactor.max, `The N-factor must be between ${LIMITS.nFactor.min} and ${LIMITS.nFactor.max}.`)
      .refine((n) => hasAtMostDecimals(n, 2), 'The N-factor can have at most 2 decimals.'),
    whole_cfm50: z.boolean({ error: 'How the tool rounds the CFM50 must be on or off.' }).default(false),
    programs: z.array(z.unknown()).max(LIMITS.programs, `At most ${LIMITS.programs} programs.`),
  })
  .loose();

function toProgram(p: StoredProgram): RebateProgram {
  return {
    key: p.key,
    name: p.name,
    label: p.label,
    tiers: p.tiers.map((t) => ({ reductionPct: t.reduction_pct, rebate: t.rebate })).sort((a, b) => a.reductionPct - b.reductionPct),
    costCapPct: p.cost_cap_pct,
    mechVentRebateCap: p.mech_vent_rebate_cap,
    source: p.source,
    effectiveDate: p.effective_date,
    paperwork: p.paperwork,
    paperworkSource: p.paperwork_source,
  };
}

/** The settings as stored (snake_case JSON). */
export function toStored(s: BlowerDoorSettings): StoredSettings {
  return {
    gauge: s.gauge,
    flow_exponent: s.flowExponent,
    n_factor: s.nFactor,
    ...(s.wholeCfm50 ? { whole_cfm50: true } : {}),
    programs: s.programs.map((p) => ({
      key: p.key,
      name: p.name,
      label: p.label,
      tiers: p.tiers.map((t) => ({ reduction_pct: t.reductionPct, rebate: t.rebate })),
      cost_cap_pct: p.costCapPct,
      mech_vent_rebate_cap: p.mechVentRebateCap,
      source: p.source,
      effective_date: p.effectiveDate,
      paperwork: p.paperwork,
      paperwork_source: p.paperworkSource,
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Lenient reading (the tool)
// ---------------------------------------------------------------------------------------------

export interface ParsedSettings {
  settings: BlowerDoorSettings;
  /** Programs or values that were left out or replaced by a default, in words. */
  problems: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The stored settings with defaults for anything missing or out of range. Never throws. */
export function parseBlowerDoorSettings(value: unknown): ParsedSettings {
  const problems: string[] = [];
  if (!isObject(value)) return { settings: EMPTY_SETTINGS, problems: value === null || value === undefined ? [] : ['The blower door settings could not be read.'] };

  const field = <T>(schema: z.ZodType<T>, v: unknown, fallback: T, what: string): T => {
    if (v === undefined || v === null) return fallback;
    const r = schema.safeParse(v);
    if (r.success) return r.data;
    problems.push(`${what} was not valid; using ${String(fallback)}.`);
    return fallback;
  };
  const shape = settingsSchema.shape;
  const gauge = field(shape.gauge, value.gauge, DEFAULT_GAUGE, 'The gauge name');
  const flowExponent = field(shape.flow_exponent, value.flow_exponent, DEFAULT_EXPONENT, 'The flow exponent');
  const nFactor = field(shape.n_factor, value.n_factor, DEFAULT_N_FACTOR, 'The N-factor');
  const wholeCfm50 = field(z.boolean(), value.whole_cfm50, false, 'How the tool rounds the CFM50');

  const programs: RebateProgram[] = [];
  const raw = Array.isArray(value.programs) ? value.programs.slice(0, LIMITS.programs) : [];
  const keys = new Set<string>();
  raw.forEach((p, i) => {
    const label = isObject(p) && typeof p.label === 'string' && p.label.trim() ? p.label.trim() : `Program ${i + 1}`;
    const r = programSchema(label).safeParse(p);
    if (!r.success) {
      problems.push(`${label} was left out: ${r.error.issues[0]?.message ?? 'it is not valid'}`);
      return;
    }
    if (keys.has(r.data.key)) {
      problems.push(`${label} was left out: another program has the same key.`);
      return;
    }
    keys.add(r.data.key);
    programs.push(toProgram(r.data));
  });
  return { settings: { gauge, flowExponent, nFactor, wholeCfm50, programs }, problems };
}

// ---------------------------------------------------------------------------------------------
// Strict validation (saving from the Rebate programs page)
// ---------------------------------------------------------------------------------------------

export type ValidatedSettings = { ok: true; value: StoredSettings; settings: BlowerDoorSettings } | { ok: false; errors: string[] };

/** Checks settings the owner submitted. Returns the JSON to store, or every problem in words. */
export function validateBlowerDoorSettings(input: unknown): ValidatedSettings {
  const top = settingsSchema.safeParse(input);
  if (!top.success) return { ok: false, errors: unique(top.error.issues.map((i) => i.message)) };
  const errors: string[] = [];
  const programs: StoredProgram[] = [];
  top.data.programs.forEach((p, i) => {
    const r = programSchema(`Program ${i + 1}`).safeParse(p);
    if (r.success) programs.push(r.data);
    else errors.push(...r.error.issues.map((x) => x.message));
  });
  const seen = (pick: (p: StoredProgram) => string, what: string) => {
    const counts = new Map<string, number>();
    for (const p of programs) counts.set(pick(p).toLowerCase(), (counts.get(pick(p).toLowerCase()) ?? 0) + 1);
    for (const [v, c] of counts) if (c > 1) errors.push(`Two programs have the same ${what} (${v}).`);
  };
  seen((p) => p.key, 'key');
  seen((p) => p.label, 'short name');
  if (errors.length) return { ok: false, errors: unique(errors) };
  const wholeCfm50 = top.data.whole_cfm50;
  const value: StoredSettings = { gauge: top.data.gauge, flow_exponent: top.data.flow_exponent, n_factor: top.data.n_factor, ...(wholeCfm50 ? { whole_cfm50: true } : {}), programs };
  return { ok: true, value, settings: { gauge: value.gauge, flowExponent: value.flow_exponent, nFactor: value.n_factor, wholeCfm50, programs: programs.map(toProgram) } };
}

const unique = (xs: string[]) => [...new Set(xs)];

/** A key for a new program from its short name, not used by any other program: "Assisted" → "assisted-2". */
export function newProgramKey(label: string, taken: readonly string[]): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'program';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/** "Nov 1, 2024" for a YYYY-MM-DD date (a calendar date: no time zone moves it). */
export function formatEffectiveDate(ymd: string | null): string | null {
  if (!ymd || !isYmd(ymd)) return null;
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}
