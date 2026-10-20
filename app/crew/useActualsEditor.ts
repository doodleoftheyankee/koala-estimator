'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { crewDb, type LocalActuals } from '@/lib/offline/crewDb';
import { applyEdits, valuesOf, type RowValues } from '@/lib/offline/crewSyncCore';
import { useLive } from '@/app/field/hooks';

const SAVE_DELAY_MS = 300;
const SYNC_DELAY_MS = 2500;

/**
 * The actuals form's state for one job. Every change is saved to IndexedDB (debounced a few
 * hundred ms) and queued for sync; `flush` saves immediately. Whenever nothing typed is waiting
 * to be saved, the form shows the stored copy, so changes from outside (a pull, another tab)
 * appear; it already holds everything this form wrote.
 */
export function useActualsEditor(jobId: string, requestSync: () => void) {
  const record = useLive(() => crewDb().actuals.get(jobId), [jobId], undefined as LocalActuals | undefined);
  const [values, setValues] = useState<Record<string, RowValues> | null>(null);

  const latest = useRef<Record<string, RowValues> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef(false);
  // Rows typed into since the last save: only these are written, so values the stored copy
  // adopted from the server meanwhile (another phone, the office) are not overwritten.
  const dirty = useRef(new Set<string>());
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!record) return;
    if (latest.current === null || (timer.current === null && !saving.current)) {
      latest.current = valuesOf(record);
      setValues(latest.current);
    }
  }, [record]);

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    if (timer.current === null) return; // nothing waiting
    timer.current = null;
    const next = latest.current;
    const keys = [...dirty.current];
    dirty.current.clear();
    if (!next || keys.length === 0) return;
    const edits = Object.fromEntries(keys.flatMap((k) => (next[k] ? [[k, next[k]] as const] : [])));
    const mutationId = crypto.randomUUID();
    saving.current = true;
    let pending = false;
    try {
      await crewDb().transaction('rw', crewDb().actuals, async () => {
        const cur = await crewDb().actuals.get(jobId);
        if (!cur || cur.syncState === 'locked') return;
        const updated = applyEdits(cur, edits, mutationId, new Date().toISOString());
        pending = updated.syncState === 'pending';
        await crewDb().actuals.put(updated);
      });
    } finally {
      saving.current = false;
    }
    if (pending && navigator.onLine) {
      if (syncTimer.current) clearTimeout(syncTimer.current);
      syncTimer.current = setTimeout(requestSync, SYNC_DELAY_MS);
    }
  }, [jobId, requestSync]);

  const setRow = useCallback(
    (key: string, patch: Partial<RowValues>) => {
      dirty.current.add(key);
      setValues((v) => {
        if (!v) return v;
        const base = v[key] ?? { materialQty: null, hours: null, crewSize: null, driveMinutes: null, days: null, notes: null };
        const next = { ...v, [key]: { ...base, ...patch } };
        latest.current = next;
        return next;
      });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  // Save when the app is backgrounded or the screen closes, so nothing typed is lost.
  useEffect(() => {
    const onHide = () => document.visibilityState === 'hidden' && void flush();
    document.addEventListener('visibilitychange', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      void flush();
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [flush]);

  return { record, values, setRow, flush };
}
