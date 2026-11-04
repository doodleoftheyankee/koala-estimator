// The open job, kept in memory and saved to IndexedDB shortly after each change.

import { getJob, saveJob } from './db';
import type { Job } from './model';

let current: Job | null = null;
let timer: number | undefined;
let pending: Promise<void> = Promise.resolve();

export async function openJob(id: string): Promise<Job | null> {
  if (current?.id === id) return current;
  await flush();
  current = (await getJob(id)) ?? null;
  return current;
}

export function setCurrent(job: Job): void {
  current = job;
}

export function currentJob(): Job | null {
  return current;
}

/** Call after any edit: saves 300 ms after the last change. */
export function changed(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => void flush(), 300);
}

/** Saves now (on navigation, or when the app goes to the background). */
export function flush(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  const job = current;
  if (!job) return pending;
  pending = pending.then(() => saveJob(job)).catch((e) => {
    console.error(e);
    alert(`Couldn't save: ${e instanceof Error ? e.message : e}`);
  });
  return pending;
}

// Phones kill backgrounded tabs without warning: save as soon as the app is hidden.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && timer !== undefined) void flush();
});
window.addEventListener('pagehide', () => {
  if (timer !== undefined) void flush();
});
