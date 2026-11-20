// The PIN's shape, for the sign-in page's PIN pad, the team page and the server (lib/auth/pin.ts).
// Pure and safe in the browser: nothing secret here.

/** A PIN is exactly this many digits. */
export const PIN_LENGTH = 4;

/** The PIN a new person starts with, and what Reset PIN offers, unless the owner types another. */
export const DEFAULT_PIN = '1234';

const PIN_RE = new RegExp(`^[0-9]{${PIN_LENGTH}}$`);

/** True for exactly four digits 0-9 (no spaces, signs or other numerals). */
export function isPin(value: unknown): value is string {
  return typeof value === 'string' && PIN_RE.test(value);
}

/**
 * What is wrong with a "Change my PIN" form (current PIN, new PIN, new PIN again), in plain words,
 * or null when it can be sent.
 */
export function newPinProblem(current: unknown, pin: unknown, again: unknown): string | null {
  if (!isPin(current)) return `Enter your current PIN (${PIN_LENGTH} digits).`;
  if (!isPin(pin)) return `Your new PIN must be ${PIN_LENGTH} digits.`;
  if (pin !== again) return `The new PINs don't match. Type the same ${PIN_LENGTH} digits twice.`;
  if (pin === current) return 'Your new PIN is the same as your current one.';
  return null;
}
