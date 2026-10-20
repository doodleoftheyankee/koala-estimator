import { describe, expect, it } from 'vitest';
import { draftSchema, newDraft, type EstimateDraft } from '@/lib/sync/draft';
import { withDraftDefaults } from './draft';

const base = () => newDraft(new Date('2026-10-20T12:00:00Z'), () => crypto.randomUUID());

/** A draft as the Phase 1 app stored it: no lineOverrides, no deviationAcks. */
function legacyDraft(): EstimateDraft {
  const d: Partial<EstimateDraft> = base();
  delete d.lineOverrides;
  delete d.deviationAcks;
  return d as EstimateDraft;
}

describe('withDraftDefaults', () => {
  it('returns the same object when the Phase 2 fields are there', () => {
    const d = base();
    expect(withDraftDefaults(d)).toBe(d);
  });

  it('adds empty lineOverrides and deviationAcks to a draft saved by the Phase 1 app', () => {
    const legacy = legacyDraft();
    expect(legacy).not.toHaveProperty('lineOverrides');
    const d = withDraftDefaults(legacy);
    expect(d.lineOverrides).toEqual({});
    expect(d.deviationAcks).toEqual({});
    expect(d).toEqual({ ...legacy, lineOverrides: {}, deviationAcks: {} });
  });

  it('keeps whichever field is present and replaces junk', () => {
    const acks = { k: 'note' };
    const d = withDraftDefaults({ ...base(), lineOverrides: null, deviationAcks: acks } as unknown as EstimateDraft);
    expect(d.lineOverrides).toEqual({});
    expect(d.deviationAcks).toBe(acks);
    const e = withDraftDefaults({ ...base(), lineOverrides: [], deviationAcks: 'x' } as unknown as EstimateDraft);
    expect(e.lineOverrides).toEqual({});
    expect(e.deviationAcks).toEqual({});
  });

  it('agrees with the schema defaults the server applies', () => {
    const legacy = legacyDraft();
    const parsed = draftSchema.parse({ ...legacy, customer: { ...legacy.customer, firstName: 'A', lastName: 'B' }, property: { ...legacy.property, street: 'x', zip: '19711' } });
    expect(withDraftDefaults(legacy).lineOverrides).toEqual(parsed.lineOverrides);
    expect(withDraftDefaults(legacy).deviationAcks).toEqual(parsed.deviationAcks);
  });
});
