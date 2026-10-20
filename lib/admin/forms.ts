// Small, pure helpers shared by the admin Server Actions and pages.
// Forms submit strings; these zod builders turn them into typed values with readable errors.
import { z } from 'zod';

/** What every admin Server Action returns to its form. */
export type ActionResult = { ok: true; message?: string; at: number } | { ok: false; error: string; at: number };

export const success = (message?: string): ActionResult => ({ ok: true, message, at: Date.now() });
export const failure = (error: string): ActionResult => ({ ok: false, error, at: Date.now() });

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------
// Percent <-> fraction (settings store fractions; people read percentages)
// ---------------------------------------------------------------------------

/** 0.18 -> 18. Rounded to 6 decimals so 0.0999 shows as 9.99, not 9.990000000000002. */
export function fractionToPercent(fraction: number): number {
  return Number((fraction * 100).toFixed(6));
}

/** 18 -> 0.18. Rounded to 8 decimals to drop float noise. */
export function percentToFraction(percent: number): number {
  return Number((percent / 100).toFixed(8));
}

// ---------------------------------------------------------------------------
// FormData -> plain object
// ---------------------------------------------------------------------------

/** Text entries of a FormData as a plain object (last value wins; files ignored). */
export function formToObject(fd: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of fd.entries()) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

/** A readable message for any thrown value, including zod errors. */
export function errorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues
      .slice(0, 3)
      .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
      .join('; ');
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

/** The human messages of a failed parse (our field builders put the label in each message). */
export function issuesMessage(error: z.ZodError): string {
  const msgs = [...new Set(error.issues.map((i) => i.message))];
  return msgs.slice(0, 4).join(' · ');
}

// ---------------------------------------------------------------------------
// Field builders
// ---------------------------------------------------------------------------

interface NumberOpts {
  min?: number;
  /** Strictly greater than. */
  gt?: number;
  max?: number;
  /** Strictly less than. */
  lt?: number;
  integer?: boolean;
}

function toNumber(raw: string): number {
  const cleaned = raw.replace(/[$,%\s]/g, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

function numberChecks(label: string, o: NumberOpts) {
  let s = z.number({ error: `${label} must be a number` });
  if (o.integer) s = s.int(`${label} must be a whole number`);
  if (o.min !== undefined) s = s.min(o.min, `${label} must be at least ${o.min}`);
  if (o.gt !== undefined) s = s.gt(o.gt, `${label} must be more than ${o.gt}`);
  if (o.max !== undefined) s = s.max(o.max, `${label} must be at most ${o.max}`);
  if (o.lt !== undefined) s = s.lt(o.lt, `${label} must be less than ${o.lt}`);
  return s;
}

const requiredString = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`);

/** Required number from a text input. "$1,200" and "15%" are accepted. */
export function numberField(label: string, opts: NumberOpts = {}) {
  return requiredString(label).transform(toNumber).pipe(numberChecks(label, opts));
}

/** Optional number: blank (or missing) -> null. */
export function optionalNumberField(label: string, opts: NumberOpts = {}) {
  return z
    .string()
    .optional()
    .transform((s) => (s === undefined || s.trim() === '' ? null : toNumber(s)))
    .pipe(numberChecks(label, opts).nullable());
}

/** A percentage typed by a person (bounds in percent), returned as a fraction. */
export function percentField(label: string, opts: NumberOpts = {}) {
  return numberField(label, opts).transform(percentToFraction);
}

/** Required single-line text. */
export function textField(label: string, max = 200) {
  return requiredString(label).max(max, `${label} must be ${max} characters or fewer`);
}

/** Optional text: blank -> null. */
export function optionalTextField(label: string, max = 200) {
  return z
    .string()
    .optional()
    .transform((s) => (s === undefined || s.trim() === '' ? null : s.trim()))
    .pipe(z.string().max(max, `${label} must be ${max} characters or fewer`).nullable());
}

/** Toggle/checkbox: "true" or "on" -> true, anything else (or missing) -> false. */
export const booleanField = z
  .string()
  .optional()
  .transform((s) => s === 'true' || s === 'on');

export const uuidField = (label: string) => z.guid({ error: `${label} is missing or not valid` });

/** Textarea with one item per line -> trimmed, non-empty lines. */
export function linesField(label: string, maxLines = 10, maxLen = 200) {
  return z
    .string()
    .optional()
    .transform((s) =>
      (s ?? '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(z.string().max(maxLen, `Each ${label.toLowerCase()} line must be ${maxLen} characters or fewer`))
        .max(maxLines, `${label}: at most ${maxLines} lines`),
    );
}

// ---------------------------------------------------------------------------
// Placeholder wording
// ---------------------------------------------------------------------------

/** True when seed text still carries the PLACEHOLDER marker. */
export function isPlaceholder(text: unknown): boolean {
  return typeof text === 'string' && /placeholder/i.test(text);
}

/**
 * Removes the seed "PLACEHOLDER" wording from a setting description once the owner has
 * saved a real value:
 *   "Overhead as % of direct cost — PLACEHOLDER"           -> "Overhead as % of direct cost"
 *   "Origin for drive-time lookups — PLACEHOLDER, set ..." -> "Origin for drive-time lookups"
 *   "PLACEHOLDER — confirm partner/terms"                  -> fallback
 */
export function stripPlaceholder(description: string | null, fallback: string | null = null): string | null {
  if (description === null) return null;
  if (!isPlaceholder(description)) return description;
  if (/^\s*placeholder\b/i.test(description)) return fallback;
  const cleaned = description
    .replace(/\s*[—–-]+\s*placeholder\b.*$/is, '')
    .replace(/\bplaceholder\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,;:—–-]+$/, '')
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

/** Postgres unique-violation code, for friendly "already exists" messages. */
export const UNIQUE_VIOLATION = '23505';

/** Parse a whole form object with a schema, returning a readable error. */
export function parseWith<T extends z.ZodType>(schema: T, obj: Record<string, string>): { ok: true; data: z.infer<T> } | { ok: false; error: string } {
  const r = schema.safeParse(obj);
  return r.success ? { ok: true, data: r.data } : { ok: false, error: issuesMessage(r.error) };
}
