// Deviation-flag acknowledgements on the phone (PLAN.md §6.5). Flags are computed offline from
// the cached model; the estimator explains each one with a note stored in draft.deviationAcks,
// keyed by DeviationFlag.key, together with the deviation (pctDiff) the note was written for.
// A note only explains a flag while the flag still has that deviation (ackState): changing a line
// or a price so that it deviates differently makes the flag pending again. A quote cannot be sent
// while any flag is unexplained, and /api/quotes applies the same rule (unacknowledgedFlags). Pure.
import { z } from 'zod';
import type { DeviationFlag } from '@/lib/learning/types';
import type { PricedOption, Tier } from '@/lib/pricing';
import type { DeviationAck, EstimateDraft } from '@/lib/sync/draft';

/** draft.deviationAcks holds at most this many characters per note (draftSchema). */
export const ACK_MAX_LENGTH = 500;

/**
 * How far a flag's pctDiff may be from the pctDiff its note was written for and still count as
 * explained: 0.02 absolute, i.e. 2 percentage points (a note for +30% covers +28% to +32%).
 *
 * Flags only exist beyond the deviation threshold (15% by default), so 2 points is small next to
 * any flagged deviation: a note for +50% labor can never cover -50%, a note for a +30% price can
 * never cover the same price once an area change leaves it 20% below the model, and a note for
 * +20% does not cover +25%. It still absorbs re-pricing that leaves the situation the estimator
 * explained as it was: pctDiff is rounded to 4 decimals and customer prices are rounded, and on a
 * +30% price a few more minutes of drive time move it about half a point (1% more area: about 2).
 * Anything larger asks the estimator to confirm (or edit) the note again. Absolute rather than
 * relative, so the band is the same for every flag and easy to state on the phone.
 */
export const ACK_PCT_TOLERANCE = 0.02;
/** Float noise allowed on top of the tolerance (pctDiff values are rounded to 4 decimals). */
const EPS = 1e-9;

/**
 * draft.deviationAcks as read. Drafts stored on a phone are not re-parsed, so values may be in the
 * bare-string form earlier builds saved (or junk); every reader goes through readAck.
 */
type Acks = Readonly<Record<string, unknown>> | undefined;

/** The flag fields the acknowledgement rule needs. */
type FlagRef = Pick<DeviationFlag, 'key' | 'pctDiff'>;

/**
 * The saved acknowledgement for a flag key, or null. Own keys only: a key is never looked up on the
 * prototype. A bare string (saved by an earlier build) is the note with an unknown deviation.
 */
export function readAck(acks: Acks, key: string): DeviationAck | null {
  if (!acks || !Object.hasOwn(acks, key)) return null;
  const value = acks[key];
  if (typeof value === 'string') return { note: value, pctDiff: null };
  if (typeof value !== 'object' || value === null) return null;
  const { note, pctDiff } = value as { note?: unknown; pctDiff?: unknown };
  if (typeof note !== 'string') return null;
  return { note, pctDiff: typeof pctDiff === 'number' && Number.isFinite(pctDiff) ? pctDiff : null };
}

/** The estimator's saved note for a flag key ('' when none), whether or not it still explains the flag. */
export function ackNote(acks: Acks, key: string): string {
  return readAck(acks, key)?.note ?? '';
}

/**
 * Does a note written for a deviation of `ackedPctDiff` explain a deviation of `pctDiff`? Only in
 * the same direction and within ACK_PCT_TOLERANCE. An unknown deviation (null) never matches.
 */
export function ackMatchesDeviation(ackedPctDiff: number | null, pctDiff: number): boolean {
  if (ackedPctDiff === null || !Number.isFinite(ackedPctDiff) || !Number.isFinite(pctDiff)) return false;
  if (Math.sign(ackedPctDiff) !== Math.sign(pctDiff)) return false;
  return Math.abs(pctDiff - ackedPctDiff) <= ACK_PCT_TOLERANCE + EPS;
}

/**
 * explained: a note (not just whitespace) written for this deviation.
 * stale: a note written for another deviation, or for an unknown one (earlier builds). It does not
 *   count; the phone shows it pre-filled for the estimator to confirm or edit.
 * missing: no note.
 */
export type AckStatus = 'explained' | 'stale' | 'missing';

export interface AckState {
  status: AckStatus;
  /** The saved note as typed ('' when none). */
  note: string;
  /** The deviation the note was written for; null when unknown or when there is no note. */
  ackedPctDiff: number | null;
}

/** The acknowledgement rule, shared by the phone, the sync payload and /api/quotes. */
export function ackState(flag: FlagRef, acks: Acks): AckState {
  const ack = readAck(acks, flag.key);
  if (!ack) return { status: 'missing', note: '', ackedPctDiff: null };
  if (!ack.note.trim()) return { status: 'missing', note: ack.note, ackedPctDiff: ack.pctDiff };
  return { status: ackMatchesDeviation(ack.pctDiff, flag.pctDiff) ? 'explained' : 'stale', note: ack.note, ackedPctDiff: ack.pctDiff };
}

/** Explained = a note with something other than whitespace, written for this deviation (ackState). */
export function isAcknowledged(flag: FlagRef, acks: Acks): boolean {
  return ackState(flag, acks).status === 'explained';
}

/**
 * The note to store with a flag (deviation_flags.ack_note, quote snapshot flags): trimmed, and only
 * while it explains the flag. A stale or blank note is never stored with a different deviation.
 */
export function acknowledgedNote(flag: FlagRef, acks: Acks): string | null {
  const state = ackState(flag, acks);
  return state.status === 'explained' ? state.note.trim() : null;
}

export function unacknowledgedFlags<F extends FlagRef>(flags: readonly F[], acks: Acks): F[] {
  return flags.filter((f) => !isAcknowledged(f, acks));
}

export interface AckSummary {
  total: number;
  acknowledged: number;
  pending: number;
  /** True when there is nothing left to explain (also when there are no flags at all). */
  allExplained: boolean;
}

export function ackSummary(flags: readonly FlagRef[], acks: Acks): AckSummary {
  const pending = unacknowledgedFlags(flags, acks).length;
  return { total: flags.length, acknowledged: flags.length - pending, pending, allExplained: pending === 0 };
}

export interface OptionFlags {
  /** This option's total-price flag(s). */
  total: DeviationFlag[];
  /** Line flags by line key. A line flag shows on every option that has the line (one note covers all). */
  byLine: Map<string, DeviationFlag[]>;
  /** total + every line flag above, without duplicates. */
  all: DeviationFlag[];
}

/** The flags to show on one option card. */
export function flagsForOption(flags: readonly DeviationFlag[], option: Pick<PricedOption, 'tier' | 'lines'>): OptionFlags {
  const keys = new Set(option.lines.map((l) => l.key).filter((k): k is string => k !== null));
  const total: DeviationFlag[] = [];
  const byLine = new Map<string, DeviationFlag[]>();
  const all: DeviationFlag[] = [];
  for (const f of flags) {
    if (f.lineKey === null) {
      if (f.tier === option.tier) {
        total.push(f);
        all.push(f);
      }
    } else if (keys.has(f.lineKey)) {
      const list = byLine.get(f.lineKey);
      if (list) list.push(f);
      else byLine.set(f.lineKey, [f]);
      all.push(f);
    }
  }
  return { total, byLine, all };
}

/**
 * Stores the note for a flag together with the flag's current deviation: typing or confirming a
 * note acknowledges the deviation as it is now. An empty note removes it. Capped to what the draft
 * schema accepts.
 */
export function setDeviationAck(draft: EstimateDraft, flag: FlagRef, note: string): EstimateDraft {
  const deviationAcks = { ...draft.deviationAcks };
  if (note === '') delete deviationAcks[flag.key];
  else deviationAcks[flag.key] = { note: note.slice(0, ACK_MAX_LENGTH), pctDiff: flag.pctDiff };
  return { ...draft, deviationAcks };
}

/** Keys of the flags one line can raise (`${lineKey}|${metric}`, lib/learning/deviation.ts). */
export function lineFlagKeys(lineKey: string): string[] {
  return [`${lineKey}|qty`, `${lineKey}|hours`];
}

/** Key of an option's total-price flag (`${tier}|total_price`, lib/learning/deviation.ts). */
export function totalFlagKey(tier: Tier): string {
  return `${tier}|total_price`;
}

/**
 * Drops the notes for these flag keys (the same draft when there is none). Used when the change a
 * note explained is taken back: a later change is a new deviation that needs its own note.
 */
export function clearDeviationAcks(draft: EstimateDraft, keys: readonly string[]): EstimateDraft {
  // Drafts saved on a phone before Phase 2 are not re-parsed and may have no deviationAcks at all.
  const current = draft.deviationAcks as EstimateDraft['deviationAcks'] | undefined;
  if (!current || !keys.some((k) => Object.hasOwn(current, k))) return draft;
  const deviationAcks = { ...current };
  for (const k of keys) delete deviationAcks[k];
  return { ...draft, deviationAcks };
}

const flagListSchema = z.array(z.object({ key: z.string(), message: z.string() }));

/**
 * The `flags` of a 409 { error: 'unacknowledged_flags' } from /api/quotes, reduced to what the
 * phone lists. Untrusted JSON: anything malformed yields [] (the caller still shows the message).
 */
export function parseFlagList(value: unknown): Array<{ key: string; message: string }> {
  const parsed = flagListSchema.safeParse(value);
  if (!parsed.success) return [];
  const seen = new Set<string>();
  const out: Array<{ key: string; message: string }> = [];
  for (const f of parsed.data) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    out.push({ key: f.key, message: f.message });
  }
  return out;
}
