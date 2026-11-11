import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newArea } from '@/lib/sync/draft';
import { newMeasurement } from '@/lib/measure/measure';
import {
  impliedR,
  impliedSqft,
  modelReadSchema,
  notesFor,
  photoReadSchema,
  readCostUsd,
  readRequestText,
  sanitizeRead,
  storedPhotoReadSchema,
  suggestionsFor,
  type PhotoRead,
} from './photoRead';

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

function raw(patch: Partial<z.infer<typeof modelReadSchema>> = {}): z.infer<typeof modelReadSchema> {
  return {
    summary: 'Attic floor with about 3 inches of settled blown fiberglass between 2x6 joists.',
    spaceSeen: 'attic_floor',
    matchesArea: true,
    existingInsulation: { material: 'Blown fiberglass', depthInches: 3, estimatedRValue: null, condition: 'settled_or_compressed', confidence: 'high', evidence: 'Joist tops show 2-3" above the fill.' },
    framing: { memberDepthInches: 5.5, spacingInches: 16, confidence: 'medium', evidence: '2x6 ceiling joists at 16" on center.' },
    size: { lengthFt: 40, widthFt: 28, sqftLow: 1000, sqftHigh: 1200, confidence: 'low', method: 'Counted about 30 joist bays at 16".' },
    access: { level: 'difficult', reason: 'Low pitch, about 3 ft at the peak.', confidence: 'medium' },
    removal: { recommended: false, reason: 'Dry and clean; top it up.' },
    hazards: [{ type: 'non_ic_recessed_lights', severity: 'caution', detail: 'Two can lights near the hatch.', photoNumbers: [2, 2, 9] }],
    obstructions: [{ name: 'HVAC platform', lengthFt: 6, widthFt: 4, count: 1, subtractFromArea: true, detail: 'Furnace on plywood.' }],
    airSealing: ['Top plates along the eaves', 'Plumbing stack'],
    estimatorNotes: ['Needs baffles at every eave bay.'],
    photoTips: ['Stand a tape measure in the insulation.'],
    ...patch,
  };
}

describe('sanitizeRead', () => {
  it('produces a value the stored schema accepts', () => {
    const read = sanitizeRead(raw());
    expect(photoReadSchema.parse(read)).toEqual(read);
    expect(read.hazards[0]!.photoNumbers).toEqual([2]); // de-duplicated, out-of-range photo dropped
  });

  it('drops impossible numbers, swaps a reversed range and trims long text', () => {
    const read = sanitizeRead(
      raw({
        summary: 'x'.repeat(5000),
        existingInsulation: { ...raw().existingInsulation, depthInches: 300, estimatedRValue: -4 },
        size: { ...raw().size, sqftLow: 1400, sqftHigh: 900 },
      }),
    );
    expect(read.summary.length).toBeLessThanOrEqual(800);
    expect(read.existingInsulation.depthInches).toBeNull();
    expect(read.existingInsulation.estimatedRValue).toBeNull();
    expect([read.size.sqftLow, read.size.sqftHigh]).toEqual([900, 1400]);
  });
});

describe('implied values', () => {
  it('works out R from depth when the model gives none', () => {
    expect(impliedR(sanitizeRead(raw()))).toBe(8); // 3" × 2.5
    expect(impliedR(sanitizeRead(raw({ existingInsulation: { ...raw().existingInsulation, estimatedRValue: 11.4 } })))).toBe(11);
    expect(impliedR(sanitizeRead(raw({ existingInsulation: { ...raw().existingInsulation, material: 'None' } })))).toBe(0);
  });

  it('takes the middle of the size range', () => {
    expect(impliedSqft(sanitizeRead(raw()))).toBe(1100);
    expect(impliedSqft(sanitizeRead(raw({ size: { ...raw().size, sqftLow: null, sqftHigh: null } })))).toBe(1120);
  });
});

describe('suggestionsFor', () => {
  const read: PhotoRead = sanitizeRead(raw());

  it('suggests each change that differs from the area', () => {
    const area = { ...newArea('attic', uuid) };
    const keys = suggestionsFor(read, area, undefined).map((s) => s.key);
    expect(keys).toEqual(['existingMaterial', 'existingDepthIn', 'currentR', 'accessLevel', 'sqft', 'cutouts', 'prepNotes']);
  });

  it('skips what already matches and never offers a size over a measured one', () => {
    const area = { ...newArea('attic', uuid), existingMaterial: 'Blown fiberglass', existingDepthIn: 3, currentR: 8, accessLevel: 'difficult' as const, sqft: 1180 };
    const s = suggestionsFor(read, area, newMeasurement('attic'));
    expect(s.map((x) => x.key)).toEqual(['cutouts', 'prepNotes']);
  });

  it('turns sized obstructions into cutouts once', () => {
    const area = newArea('attic', uuid);
    const cut = suggestionsFor(read, area, undefined).find((s) => s.key === 'cutouts')!;
    expect(cut.measurement!.cutouts).toHaveLength(1);
    expect(cut.measurement!.cutouts[0]).toMatchObject({ label: 'HVAC platform', qty: '1', shape: { kind: 'rect', dims: { A: '6', B: '4' } } });
    const again = suggestionsFor(read, area, cut.measurement);
    expect(again.find((s) => s.key === 'cutouts')).toBeUndefined();
  });

  it('offers the cavity depth only for cavity jobs, snapped to lumber sizes', () => {
    const walls = newArea('walls', uuid);
    expect(suggestionsFor(read, walls, undefined).find((s) => s.key === 'depthIn')?.patch).toEqual({ depthIn: 5.5 });
    expect(suggestionsFor(read, newArea('attic', uuid), undefined).find((s) => s.key === 'depthIn')).toBeUndefined();
  });

  it('suggests nothing when the photos are of something else', () => {
    expect(suggestionsFor(sanitizeRead(raw({ matchesArea: false })), newArea('attic', uuid), undefined)).toEqual([]);
  });

  it('appends notes once', () => {
    const area = newArea('attic', uuid);
    const notes = suggestionsFor(read, area, undefined).find((s) => s.key === 'prepNotes')!;
    expect(notes.patch!.prepNotes).toContain('Caution: Recessed lights that may not be IC-rated');
    const after = { ...area, prepNotes: notes.patch!.prepNotes! };
    expect(suggestionsFor(read, after, undefined).find((s) => s.key === 'prepNotes')).toBeUndefined();
  });
});

describe('prompt text and cost', () => {
  it('describes the area and what was entered', () => {
    const text = readRequestText(
      { estimateId: uuid(), areaId: uuid(), areaName: 'Main attic', jobType: 'attic', sqft: 1180, measured: true, currentR: 11, existingMaterial: 'Cellulose', yearBuilt: 1962, codeR: 49 },
      3,
    );
    expect(text).toContain('These 3 photos show an attic');
    expect(text).toContain('built in 1962');
    expect(text).toContain('R-49');
    expect(text).toContain('measured 1180 sq ft');
    expect(text).toContain('Cellulose at about R-11');
  });

  it('prices tokens at Opus 5.5 rates', () => {
    expect(readCostUsd({ input_tokens: 10_000, output_tokens: 3_000 })).toBe(0.1);
  });

  it('notes start with a marker line', () => {
    expect(notesFor(sanitizeRead(raw()))!.split('\n')[0]).toBe('From photo read:');
  });

  it('stores a read with its decisions', () => {
    const stored = { read: sanitizeRead(raw()), analysisId: null, model: 'claude-opus-5-5', createdAt: new Date().toISOString(), photoIds: ['a'], decisions: { currentR: 'applied' as const } };
    expect(storedPhotoReadSchema.parse(stored)).toEqual(stored);
  });
});
