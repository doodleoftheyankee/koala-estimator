// Readings saved to a job or an estimate (table blower_door_tests): the shape the phone sends, the
// shape the server returns, and the job's result worked out from the readings as recorded. Pure.
//
// A saved reading is never changed: a retest is a new reading, and the newest of each kind is the
// one that counts. Its CFM50 is the one worked out on the phone when it was taken (the database
// checks it matches the reading and its exponent), so a later change of the default exponent never
// moves an old result.
import { z } from 'zod';
import { isStories, toCfm50, type Stories } from './calc';
import { emptyForm, evaluate, type BlowerDoorForm, type Evaluation, type Reading } from './evaluate';
import { RULES } from './numbers';
import { DEFAULT_EXPONENT, DEFAULT_N_FACTOR, parseBlowerDoorSettings, toStored, type BlowerDoorSettings, type RebateProgram, type StoredProgram } from './settings';

export const TEST_KINDS = ['test_in', 'test_out'] as const;
export type TestKind = (typeof TEST_KINDS)[number];
export const KIND_LABELS: Record<TestKind, string> = { test_in: 'Test-in', test_out: 'Test-out' };

/** How far a sent CFM50 may be from CFM × (50 ÷ Pa)^n (rounding on the phone). */
export const CFM50_TOLERANCE = 0.5;

const finite = z.number().refine(Number.isFinite, 'must be a number');
const inRange = (r: { min: number; max: number; minExclusive?: boolean }, what: string) =>
  finite.refine((n) => (r.minExclusive ? n > r.min : n >= r.min) && n <= r.max, `${what} is out of range`);
const optional = <T extends z.ZodType>(s: T) => s.nullable().optional().transform((v) => v ?? null);

/** What the phone sends for one reading (POST /api/blower-door/tests). */
export const newTestSchema = z
  .object({
    id: z.guid(),
    jobId: z.guid().nullable(),
    estimateId: z.guid().nullable(),
    kind: z.enum(TEST_KINDS),
    cfm: inRange(RULES.cfm, 'Fan flow'),
    pa: inRange(RULES.pa, 'House pressure'),
    exponent: inRange(RULES.exponent, 'Flow exponent'),
    cfm50: finite.positive(),
    programKey: optional(z.string().max(40)),
    /** The program as it was when the reading was taken (its stored JSON). */
    program: optional(z.record(z.string(), z.unknown())),
    airSealingCost: optional(inRange(RULES.cost, 'Air sealing price')),
    basAudit: optional(inRange(RULES.bas, 'BAS')),
    volume: optional(inRange(RULES.volume, 'House volume')),
    occupants: optional(inRange(RULES.occupants, 'Occupants').refine(Number.isInteger, 'Occupants must be a whole number')),
    stories: optional(z.enum(['1', '1.5', '2', '2.5', '3'])),
    nFactor: optional(inRange(RULES.nFactor, 'Zone N-factor')),
    /** What the phone showed when it was saved (for the record; the office works it out again). */
    result: optional(z.record(z.string(), z.unknown())),
    recordedAt: z.iso.datetime({ offset: true }),
  })
  .refine((t) => (t.jobId === null) !== (t.estimateId === null), 'A reading belongs to a job or an estimate.')
  .refine((t) => {
    const expect = toCfm50(t.cfm, t.pa, t.exponent);
    return expect !== null && Math.abs(expect - t.cfm50) <= CFM50_TOLERANCE;
  }, 'The CFM50 does not match the reading.');
export type NewTest = z.output<typeof newTestSchema>;

/** The RPC's p_test (snake_case, as the table names its columns). */
export function toRpcTest(t: NewTest): Record<string, unknown> {
  return {
    id: t.id,
    job_id: t.jobId,
    estimate_id: t.estimateId,
    kind: t.kind,
    cfm: t.cfm,
    pa: t.pa,
    exponent: t.exponent,
    cfm50: t.cfm50,
    program_key: t.programKey,
    program: t.program,
    air_sealing_cost: t.airSealingCost,
    bas_audit: t.basAudit,
    volume: t.volume,
    occupants: t.occupants,
    stories: t.stories === null ? null : Number(t.stories),
    n_factor: t.nFactor,
    result: t.result,
    recorded_at: t.recordedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// Saved readings, as the server returns them
// ---------------------------------------------------------------------------------------------

const numeric = z.union([z.number(), z.string()]).transform((v) => Number(v)).pipe(z.number().refine(Number.isFinite));
const numericOrNull = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || v === '' ? null : Number(v)))
  .pipe(z.number().refine(Number.isFinite).nullable());

export const savedTestSchema = z.object({
  id: z.guid(),
  job_id: z.guid().nullable(),
  estimate_id: z.guid().nullable(),
  kind: z.enum(TEST_KINDS),
  cfm: numeric,
  pa: numeric,
  exponent: numeric,
  cfm50: numeric,
  program_key: z.string().nullable().optional().transform((v) => v ?? null),
  program: z.unknown().optional().transform((v) => v ?? null),
  air_sealing_cost: numericOrNull,
  bas_audit: numericOrNull,
  volume: numericOrNull,
  occupants: numericOrNull,
  stories: numericOrNull,
  n_factor: numericOrNull,
  recorded_by: z.guid(),
  recorded_by_name: z.string().nullable().optional().transform((v) => v ?? null),
  recorded_at: z.string(),
});
export type SavedTest = z.output<typeof savedTestSchema>;

/** A saved reading as the tool uses it. */
export const asReading = (t: Pick<SavedTest, 'cfm' | 'pa' | 'exponent' | 'cfm50'>): Reading => ({ cfm: t.cfm, pa: t.pa, exponent: t.exponent, cfm50: t.cfm50 });

/** Newest first; a tie (same second) keeps the later one in the list first. */
export function newestFirst<T extends Pick<SavedTest, 'recorded_at'>>(rows: readonly T[]): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.recorded_at.localeCompare(a.r.recorded_at) || b.i - a.i)
    .map((x) => x.r);
}

export interface LatestReadings<T> {
  testIn: T | null;
  testOut: T | null;
  /** Older readings of either kind, newest first. */
  earlier: T[];
}

/** The newest test-in and test-out; the rest are earlier readings. */
export function latestReadings<T extends Pick<SavedTest, 'kind' | 'recorded_at'>>(rows: readonly T[]): LatestReadings<T> {
  const sorted = newestFirst(rows);
  const testIn = sorted.find((r) => r.kind === 'test_in') ?? null;
  const testOut = sorted.find((r) => r.kind === 'test_out') ?? null;
  return { testIn, testOut, earlier: sorted.filter((r) => r !== testIn && r !== testOut) };
}

/** The program stored with a reading, read leniently (null when it is missing or not valid). */
export function programOf(t: Pick<SavedTest, 'program'> | null): RebateProgram | null {
  if (!t || t.program === null || typeof t.program !== 'object') return null;
  return parseBlowerDoorSettings({ programs: [t.program] }).settings.programs[0] ?? null;
}

type BasRow = Pick<SavedTest, 'bas_audit' | 'volume' | 'occupants' | 'stories' | 'n_factor'>;
const hasBas = (t: BasRow | null): t is BasRow => !!t && [t.bas_audit, t.volume, t.occupants].some((v) => v !== null);
const text = (n: number | null) => (n === null ? '' : String(n));

/** The form fields a saved reading fills in (the BAS inputs and the price), for the tool and the office. */
export function savedInputs(t: (BasRow & Pick<SavedTest, 'air_sealing_cost'>) | null): Partial<BlowerDoorForm> {
  if (!t) return {};
  const stories = t.stories === null ? null : String(t.stories);
  return {
    bas: text(t.bas_audit),
    volume: text(t.volume),
    occupants: text(t.occupants),
    ...(isStories(stories) ? { stories: stories as Stories } : {}),
    ...(t.n_factor !== null ? { nFactor: String(t.n_factor) } : {}),
    ...(t.air_sealing_cost !== null ? { cost: String(t.air_sealing_cost) } : {}),
  };
}

/**
 * The program a job's or estimate's saved readings were taken under, for a phone that has not
 * chosen one: the newest reading's program that the franchise still has (the estimator's choice at
 * the test-in reaches the crew's test-out). Null when no saved reading names one.
 */
export function savedProgramKey(rows: readonly Pick<SavedTest, 'program_key' | 'recorded_at'>[], settings: Pick<BlowerDoorSettings, 'programs'>): string | null {
  const keys = new Set(settings.programs.map((p) => p.key));
  return newestFirst(rows).find((r) => r.program_key !== null && keys.has(r.program_key))?.program_key ?? null;
}

/** The air sealing price of a job: from the newest reading that was saved with one (any kind). */
export function savedPrice(rows: readonly Pick<SavedTest, 'air_sealing_cost' | 'recorded_at'>[]): number | null {
  return newestFirst(rows).find((r) => r.air_sealing_cost !== null && r.air_sealing_cost > 0)?.air_sealing_cost ?? null;
}

export interface JobBlowerDoor extends LatestReadings<SavedTest> {
  /** The result from the newest readings as recorded, with the program saved with the test-out. */
  evaluation: Evaluation | null;
  settings: BlowerDoorSettings;
  /** The test-in and the test-out were saved under different programs (their short names). */
  programMismatch: { testIn: string; testOut: string } | null;
}

/**
 * The job's result from its saved readings: the newest test-in against the newest test-out, the
 * program saved with the test-out (else the test-in; a different program on each is reported in
 * programMismatch), the BAS inputs given with the test-out (else the test-in), and the air sealing
 * price for the cost cap from the newest reading saved with one: a crew never sends a price, so the
 * estimator's price from the test-in caps a crew's test-out. `whole`: the franchise decides on
 * whole-number CFM50s (its current setting).
 */
export function jobBlowerDoor(rows: readonly SavedTest[], gauge: string, opts: { wholeCfm50?: boolean } = {}): JobBlowerDoor {
  const latest = latestReadings(rows);
  const { testIn, testOut } = latest;
  const inProgram = programOf(testIn);
  const outProgram = programOf(testOut);
  const program = outProgram ?? inProgram;
  const settings: BlowerDoorSettings = {
    gauge,
    flowExponent: testOut?.exponent ?? testIn?.exponent ?? DEFAULT_EXPONENT,
    nFactor: DEFAULT_N_FACTOR,
    wholeCfm50: opts.wholeCfm50 === true,
    programs: program ? [program] : [],
  };
  const programMismatch = inProgram && outProgram && inProgram.key !== outProgram.key ? { testIn: inProgram.label, testOut: outProgram.label } : null;
  if (!testIn && !testOut) return { ...latest, evaluation: null, settings, programMismatch };
  const basRow = hasBas(testOut) ? testOut : hasBas(testIn) ? testIn : null;
  const price = savedPrice(rows);
  const form: BlowerDoorForm = {
    ...emptyForm(settings, program?.key ?? null),
    ...savedInputs(basRow),
    cost: price === null ? '' : String(price),
  };
  const evaluation = evaluate({ form, settings, savedIn: testIn ? asReading(testIn) : null, savedOut: testOut ? asReading(testOut) : null });
  return { ...latest, evaluation, settings, programMismatch };
}

/** The stored JSON of a program, to send with a reading. */
export const programSnapshot = (p: RebateProgram | null): StoredProgram | null =>
  p ? toStored({ gauge: '', flowExponent: DEFAULT_EXPONENT, nFactor: DEFAULT_N_FACTOR, wholeCfm50: false, programs: [p] }).programs[0]! : null;

// ---------------------------------------------------------------------------------------------
// The API's answers
// ---------------------------------------------------------------------------------------------

/** POST /api/blower-door/tests: what happened to one reading. */
export const testSyncResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), id: z.guid(), recorded_at: z.string() }),
  /** The estimate has not synced from the phone yet: send the reading again later. */
  z.object({ status: z.literal('waiting') }),
  /** refused: not the caller's job or estimate (now). invalid: values no gauge gives. rejected: someone else's id. error: try again. */
  z.object({ status: z.enum(['refused', 'invalid', 'rejected', 'error']), error: z.string() }),
]);
export type TestSyncResponse = z.output<typeof testSyncResponseSchema>;

/** GET /api/blower-door/tests?job= | ?estimate=: who the readings are for and the saved readings. */
export const contextResponseSchema = z.object({
  jobId: z.guid().nullable(),
  estimateId: z.guid(),
  label: z.string().nullable(),
  tests: z.array(savedTestSchema),
});
export type ContextResponse = z.output<typeof contextResponseSchema>;

/** GET /api/blower-door/settings. */
export interface SettingsResponse {
  settings: BlowerDoorSettings;
  problems: string[];
  /** Changes whenever the stored settings do (the ETag). */
  hash: string;
}
