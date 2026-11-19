// The Send step tells nobody to finish a business profile (owner decision OD12; review A DOC-3,
// review B flow-B1): not the estimator ("Ask the owner or the office to finish it", which the
// office could not do), not the office, not the owner, even on a phone whose cached bundle still
// carries the old gaps.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/offline/db', () => ({ db: () => ({}), getCachedBundle: async () => null }));
vi.mock('@/lib/offline/sync', () => ({ refreshBundle: async () => null, syncEstimate: async () => null, isReachable: () => true, onReachChange: () => () => {} }));

import { seededSnapshot } from '@/lib/pricing/__fixtures__/seeded';
import { newArea, newDraft } from '@/lib/sync/draft';
import { SendStep } from './SendStep';

function render(role: 'estimator' | 'office' | 'owner'): string {
  const draft = newDraft(new Date('2026-11-19T15:00:00Z'), undefined, { city: 'Springfield', state: 'IL' });
  draft.customer = { ...draft.customer, firstName: 'Riley', lastName: 'Quinn', email: 'riley@example.com' };
  draft.property = { ...draft.property, street: '12 Elm St', zip: '62701' };
  draft.areas = [{ ...newArea('attic'), sqft: 1200 }];
  // A bundle downloaded before OD12 still names the gaps.
  const bundle = { snapshot: seededSnapshot, business: { gaps: ['the license number', 'the office phone'], newEstimate: { city: '', state: '' } } };
  const html = renderToStaticMarkup(
    createElement(SendStep, {
      draft,
      record: { id: 'e1', draft, syncState: 'synced' } as never,
      priced: null,
      flags: [],
      bundle: bundle as never,
      profile: { userId: 'u', role, fullName: 'X', email: null } as never,
      online: true,
      flush: async () => {},
      locked: false,
      onFix: () => {},
    } as never),
  );
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

describe('OD12 / DOC-3: the Send step never asks anyone to finish the business profile', () => {
  it.each(['estimator', 'office', 'owner'] as const)('%s: no business-profile item, sentence or link', (role) => {
    const text = render(role);
    expect(text).toContain('Ready to send?');
    expect(text).not.toMatch(/business profile/i);
    expect(text).not.toMatch(/or the office to finish/);
    expect(text).not.toContain('/admin/business');
  });
});
