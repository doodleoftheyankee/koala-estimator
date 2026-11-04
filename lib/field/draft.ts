// Drafts stored on the phone are kept as they were written, not re-parsed, so one saved by an
// earlier build lacks the later fields (lineOverrides, deviationAcks, measurements). The editor
// adopts drafts through this. Pure.
import type { EstimateDraft } from '@/lib/sync/draft';

type LaterFields = 'lineOverrides' | 'deviationAcks' | 'measurements';

/** The draft with the later fields present (same object when nothing is missing). */
export function withDraftDefaults(draft: EstimateDraft): EstimateDraft {
  const d = draft as Omit<EstimateDraft, LaterFields> & Partial<Pick<EstimateDraft, LaterFields>>;
  if (isRecord(d.lineOverrides) && isRecord(d.deviationAcks) && isRecord(d.measurements)) return draft;
  return {
    ...d,
    lineOverrides: isRecord(d.lineOverrides) ? d.lineOverrides : {},
    deviationAcks: isRecord(d.deviationAcks) ? d.deviationAcks : {},
    measurements: isRecord(d.measurements) ? d.measurements : {},
  };
}

function isRecord<T>(v: T | undefined | null): v is T {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
