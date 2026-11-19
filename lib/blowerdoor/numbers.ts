// Reading what a person typed into a blower door field. Pure.
//
// A gauge shows depressurization as a negative pressure ("-50.8"), and people paste prices with a
// dollar sign and commas, so a number is read with "$", "," and spaces taken out and
// its sign dropped. Every field has a sensible range: a value outside it is an error the screen
// shows under the field, never a NaN or an Infinity in a result.

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
}

const fmtLimit = (n: number, rule: FieldRule) => {
  const s = n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return rule.money ? `$${s}` : rule.unit ? `${s} ${rule.unit}` : s;
};

/** The number in a typed text: "$ 12,345" → 12345, "-50.8" → 50.8, "" → null, "abc" → NaN. */
export function readNumber(text: string | null | undefined): number | null {
  const cleaned = String(text ?? '').replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  // A lone sign or dot is not a number yet (someone is still typing "-50").
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return Number.NaN;
  return Math.abs(Number(cleaned));
}

/** A typed field checked against its rule. */
export function readField(text: string | null | undefined, rule: FieldRule): FieldValue {
  const n = readNumber(text);
  if (n === null) return { state: 'empty' };
  if (!Number.isFinite(n)) return { state: 'invalid', error: `${rule.label}: type a number.` };
  if (rule.integer && !Number.isInteger(n)) return { state: 'invalid', error: `${rule.label} must be a whole number.` };
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
 */
export const RULES = {
  cfm: { label: 'Fan flow', min: 0, minExclusive: true, max: 50_000, unit: 'CFM' },
  pa: { label: 'House pressure', min: 1, max: 100, unit: 'Pa' },
  exponent: { label: 'Flow exponent', min: 0.5, max: 1 },
  cost: { label: 'Air sealing price', min: 0, minExclusive: true, max: 1_000_000, money: true },
  bas: { label: 'BAS', min: 1, max: 100_000, unit: 'CFM50' },
  volume: { label: 'House volume', min: 500, max: 1_000_000, unit: 'ft³' },
  occupants: { label: 'Occupants', min: 0, max: 50, integer: true },
  nFactor: { label: 'Zone N-factor', min: 1, max: 40 },
} as const satisfies Record<string, FieldRule>;

/**
 * Below this house pressure the CFM50 is stretched a long way from the reading (at 20 Pa the flow
 * is multiplied by 1.8): the screen says so, and suggests testing nearer 50 Pa.
 */
export const LOW_PRESSURE_PA = 25;
