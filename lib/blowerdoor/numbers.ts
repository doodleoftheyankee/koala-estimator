// Reading what a person typed into a blower door field. Pure.
//
// A gauge shows depressurization as a negative pressure ("-50.8"), and people paste prices with a
// dollar sign and commas, so a number is read with "$", "," and spaces taken out and
// its sign dropped. Every field has a sensible range: a value outside it is an error the screen
// shows under the field, never a NaN or an Infinity in a result. A value is read at the precision
// a saved reading keeps (the database columns), so what the screen works out is what is saved.

export type FieldValue =
  | { state: 'empty' }
  | { state: 'ok'; value: number }
  | { state: 'invalid'; error: string };

export interface FieldRule {
  /** The field's name in messages: "Fan flow". */
  label: string;
  /** Smallest allowed value (after the sign is dropped). */
  min: number;
  /** True: the value must be more than min, not equal to it. */
  minExclusive?: boolean;
  max: number;
  /** The unit after the number in messages: "CFM", "Pa", "ft³". */
  unit?: string;
  integer?: boolean;
  /** Put "$" before the numbers in messages. */
  money?: boolean;
  /** Read at this many decimals (rounded), the precision a saved reading keeps. */
  decimals?: number;
  /** Refuse more decimals than this (instead of rounding them away). */
  maxDecimals?: number;
}

const fmtLimit = (n: number, rule: FieldRule) => {
  const s = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return rule.money ? `$${s}` : rule.unit ? `${s} ${rule.unit}` : s;
};

/** The number in a typed text: "$ 12,345" → 12345, "-50.8" → 50.8, "" or "-" → null, "abc" → NaN. */
export function readNumber(text: string | null | undefined): number | null {
  const cleaned = String(text ?? '').replace(/[$,\s]/g, '');
  // A lone sign or dot is not a number yet (someone is still typing "-50"): empty, not an error.
  if (cleaned === '' || /^[+-]?\.?$/.test(cleaned)) return null;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return Number.NaN;
  return Math.abs(Number(cleaned));
}

/** True when n has no more than d decimals (0.6500 has 2; floating-point noise is ignored). */
export function hasAtMostDecimals(n: number, d: number): boolean {
  const scaled = n * 10 ** d;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

const roundTo = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** A typed field checked against its rule. */
export function readField(text: string | null | undefined, rule: FieldRule): FieldValue {
  const typed = readNumber(text);
  if (typed === null) return { state: 'empty' };
  if (!Number.isFinite(typed)) return { state: 'invalid', error: `${rule.label}: type a number.` };
  // Rounded first, so the range is checked on the value that is used and saved.
  const n = rule.decimals !== undefined ? roundTo(typed, rule.decimals) : typed;
  if (rule.integer && !Number.isInteger(n)) return { state: 'invalid', error: `${rule.label} must be a whole number.` };
  if (rule.maxDecimals !== undefined && !hasAtMostDecimals(n, rule.maxDecimals)) {
    return { state: 'invalid', error: `${rule.label}: at most ${rule.maxDecimals} decimal${rule.maxDecimals === 1 ? '' : 's'}.` };
  }
  const tooLow = rule.minExclusive ? n <= rule.min : n < rule.min;
  if (tooLow || n > rule.max) {
    const low = rule.minExclusive ? `more than ${fmtLimit(rule.min, rule)}` : `at least ${fmtLimit(rule.min, rule)}`;
    return { state: 'invalid', error: `${rule.label} must be ${low} and at most ${fmtLimit(rule.max, rule)}.` };
  }
  return { state: 'ok', value: n };
}

/** The value of a field, or null when it is empty or invalid. */
export const valueOf = (f: FieldValue): number | null => (f.state === 'ok' ? f.value : null);

/** The error of a field, or null. */
export const errorOf = (f: FieldValue): string | null => (f.state === 'invalid' ? f.error : null);

// ---------------------------------------------------------------------------------------------
// The fields of the tool and their ranges
// ---------------------------------------------------------------------------------------------

/**
 * Ranges a real house and a real gauge stay inside. Fan flow tops out around 6,000 CFM per fan,
 * so 50,000 leaves room for several fans on a big building. House pressure is the gauge's
 * channel A reading: tests run at or near 50 Pa, and a reading above 100 Pa is a typing slip.
 * The flow exponent n of a house sits between 0.5 (turbulent) and 1.0 (laminar).
 * Decimals follow the columns of blower_door_tests. The exponent changes the CFM50 a lot per
 * decimal, so a fourth decimal is refused rather than rounded away without a word.
 */
export const RULES = {
  cfm: { label: 'Fan flow', min: 0, minExclusive: true, max: 50_000, unit: 'CFM', decimals: 2 },
  pa: { label: 'House pressure', min: 1, max: 100, unit: 'Pa', decimals: 2 },
  exponent: { label: 'Flow exponent', min: 0.5, max: 1, maxDecimals: 3 },
  cost: { label: 'Air sealing price', min: 0, minExclusive: true, max: 1_000_000, money: true, decimals: 2 },
  bas: { label: 'BAS', min: 1, max: 100_000, unit: 'CFM50', decimals: 1 },
  volume: { label: 'House volume', min: 500, max: 1_000_000, unit: 'ft³', decimals: 1 },
  occupants: { label: 'Occupants', min: 0, max: 50, integer: true },
  nFactor: { label: 'Zone N-factor', min: 1, max: 40, decimals: 2 },
} as const satisfies Record<string, FieldRule>;

/**
 * Below this house pressure the CFM50 is stretched a long way from the reading (at 20 Pa the flow
 * is multiplied by 1.8): the screen says so, and suggests testing nearer 50 Pa.
 */
export const LOW_PRESSURE_PA = 25;
