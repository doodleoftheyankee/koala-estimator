// Deviation-flag acknowledgements on the phone (PLAN.md §6.5). Flags are computed offline from
// the cached model; the estimator explains each one with a note stored in draft.deviationAcks,
// keyed by DeviationFlag.key. A quote cannot be sent while any flag lacks a note. Pure.
import { z } from 'zod';
import type { DeviationFlag } from '@/lib/learning/types';
import type { PricedOption } from '@/lib/pricing';
import type { EstimateDraft } from '@/lib/sync/draft';

/** draft.deviationAcks holds at most this many characters per note (draftSchema). */
export const ACK_MAX_LENGTH = 500;

type Acks = Readonly<Record<string, string>> | undefined;

/** The estimator's note for a flag key ('' when none). Own keys only: a key is never looked up on the prototype. */
export function ackNote(acks: Acks, key: string): string {
  if (!acks || !Object.hasOwn(acks, key)) return '';
  const note = acks[key];
  return typeof note === 'string' ? note : '';
}

/** Explained = a note with something other than whitespace (the server trims before checking). */
export function isAcknowledged(flag: Pick<DeviationFlag, 'key'>, acks: Acks): boolean {
  return ackNote(acks, flag.key).trim().length > 0;
}

export function unacknowledgedFlags<F extends Pick<DeviationFlag, 'key'>>(flags: readonly F[], acks: Acks): F[] {
  return flags.filter((f) => !isAcknowledged(f, acks));
}

export interface AckSummary {
  total: number;
  acknowledged: number;
  pending: number;
  /** True when there is nothing left to explain (also when there are no flags at all). */
  allExplained: boolean;
}

export function ackSummary(flags: ReadonlyArray<Pick<DeviationFlag, 'key'>>, acks: Acks): AckSummary {
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

/** Stores the note for a flag key; an empty note removes it. Capped to what the draft schema accepts. */
export function setDeviationAck(draft: EstimateDraft, key: string, note: string): EstimateDraft {
  const deviationAcks = { ...draft.deviationAcks };
  if (note === '') delete deviationAcks[key];
  else deviationAcks[key] = note.slice(0, ACK_MAX_LENGTH);
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
