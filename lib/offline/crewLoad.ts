'use client';
// The load list on the crew's phone: which lines are ticked off (kept in the crew app's IndexedDB,
// per person and day, so it works with no signal and a new day starts empty) and the blower door
// readings of the jobs on it (the tool's own store, filled from the existing price-free
// GET /api/blower-door/tests while there is signal).
import { staleTickKeys, ticksKey, tickOf, toggleTick, type EquipmentLine, type LoadLine, type Ticks } from '@/lib/jobs/loadList';
import { fetchContext } from './blowerDoor';
import { crewDb } from './crewDb';

/**
 * Ticks a line off, or back on: a material is ticked at the amount it says now (so the tick no
 * longer counts once the amount changes). Drops the ticks of days before `today` as it goes.
 */
export async function toggleLoaded(ownerId: string, date: string, line: LoadLine | EquipmentLine, today: string): Promise<void> {
  const db = crewDb();
  await db.transaction('rw', db.meta, async () => {
    const key = ticksKey(ownerId, date);
    const current = ((await db.meta.get(key))?.value as Ticks | undefined) ?? {};
    await db.meta.put({ key, value: toggleTick(current, line.key, tickOf(line)) });
    const stale = staleTickKeys((await db.meta.toCollection().primaryKeys()) as string[], ownerId, today);
    if (stale.length) await db.meta.bulkDelete(stale);
  });
}

/** One run at a time; jobs asked for while it runs are fetched by the same run, after the others. */
let refreshing: Promise<void> | null = null;
const queued = new Map<string, string>(); // job id -> owner id

/**
 * Loads the saved blower door readings of these jobs onto the phone (the same copy the job page
 * and the tool keep), so the load list knows which jobs still need the kit for a test-out. Only
 * with signal; never throws. A crew's copy carries no price (blower_door_context).
 */
export function refreshBlowerDoorReadings(jobIds: readonly string[], ownerId: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.onLine) return refreshing ?? Promise.resolve();
  for (const id of jobIds) queued.set(id, ownerId);
  refreshing ??= (async () => {
    while (queued.size && navigator.onLine) {
      const [id, owner] = queued.entries().next().value!;
      queued.delete(id);
      const r = await fetchContext({ kind: 'job', id, label: null }, owner).catch(() => null);
      if (r === 'signed-out') break;
    }
    queued.clear();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}
