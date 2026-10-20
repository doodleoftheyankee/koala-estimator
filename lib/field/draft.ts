// Drafts stored on the phone are kept as they were written, not re-parsed, so one saved by the
// Phase 1 app has no lineOverrides or deviationAcks. The editor adopts drafts through this. Pure.
import type { EstimateDraft } from '@/lib/sync/draft';

/** The draft with the Phase 2 fields present (same object when nothing is missing). */
export function withDraftDefaults(draft: EstimateDraft): EstimateDraft {
  const d = draft as Omit<EstimateDraft, 'lineOverrides' | 'deviationAcks'> & Partial<Pick<EstimateDraft, 'lineOverrides' | 'deviationAcks'>>;
  if (isRecord(d.lineOverrides) && isRecord(d.deviationAcks)) return draft;
  return {
    ...d,
    lineOverrides: isRecord(d.lineOverrides) ? d.lineOverrides : {},
    deviationAcks: isRecord(d.deviationAcks) ? d.deviationAcks : {},
  };
}

function isRecord<T>(v: T | undefined | null): v is T {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
