// The Options step on the phone (review A: F1, M2, F10). Rendered to markup with the pricing a new
// database starts with, so the prices here are the prices a quote gets today.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { priceEstimate, type AreaInput, type PricedEstimate } from '@/lib/pricing';
import { seededArea, seededBundle } from '@/lib/pricing/__fixtures__/seeded';
import { newDraft, toEstimateInput, type EstimateDraft } from '@/lib/sync/draft';
import { fixElementId } from '@/lib/field/fix';
import { OptionsStep } from './OptionsStep';

const AREA_ID = '00000000-0000-4000-8000-000000000001';

function draftWith(area: AreaInput, patch: Partial<EstimateDraft> = {}): EstimateDraft {
  const d = newDraft(new Date('2026-11-19T12:00:00Z'), () => '00000000-0000-4000-8000-0000000000ff');
  return { ...d, areas: [area], driveMinutesOneWay: 20, ...patch };
}

const priceOf = (draft: EstimateDraft): PricedEstimate => priceEstimate(toEstimateInput(draft), seededBundle.snapshot, seededBundle.coefficientSet);

function render(draft: EstimateDraft, editPrice: 'good' | 'better' | 'best' | null = null): string {
  return renderToStaticMarkup(
    <OptionsStep
      editPrice={editPrice}
      draft={draft}
      update={() => {}}
      bundle={seededBundle}
      priced={{ ok: priceOf(draft), error: null }}
      flags={[]}
      profile={{ userId: 'u', fullName: 'E', role: 'estimator' }}
      online
    />,
  );
}

/** The markup of one option card (role=group, aria-label "<Tier> option"). */
function card(html: string, label: string): string | null {
  const start = html.indexOf(`aria-label="${label} option"`);
  if (start < 0) return null;
  const next = html.indexOf('role="group"', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

describe('F1, M2 (OD6): an option the estimator priced out of view stays on the phone, so the change can be undone', () => {
  // Attic 1,000 sq ft, R-0, 20 min: Good $2,995, Better $4,390, Best $4,390 (Best is the same work).
  it('Good set to $4,500, above Better ($4,390): Good is not shown to the customer, but its card stays, collapsed, with Remove price change', () => {
    const draft = draftWith(seededArea({ id: AREA_ID }), { overrides: { good: { price: 4500, reason: 'Premium' } } });
    expect(priceOf(draft).options.map((o) => o.tier)).toEqual(['better']);
    const html = render(draft);
    const good = card(html, 'Good');
    expect(good).not.toBeNull();
    expect(good).toContain('Not shown to the customer');
    expect(good).toContain('Good is not shown to the customer: it costs $4,500, more than Better ($4,390), the next option up. Change its price to show it.');
    expect(good).toContain('Change price');
    expect(good).toContain('Remove price change');
    // It is not offered to the customer, so it cannot be made the recommended option.
    expect(good).not.toContain('Make recommended');
    // The shown option is still the one card that looks like an option the customer gets.
    expect(card(html, 'Better')).toContain('Recommended (default)');
  });

  it('Better then set to $9,000 on the one card left: Better is hidden too, and both hidden cards keep their price change (M2)', () => {
    const draft = draftWith(seededArea({ id: AREA_ID }), {
      overrides: { good: { price: 4500, reason: 'Premium' }, better: { price: 9000, reason: 'Premium' } },
    });
    expect(priceOf(draft).options.map((o) => o.tier)).toEqual(['best']);
    const html = render(draft);
    for (const t of ['Good', 'Better']) {
      expect(card(html, t)).toContain('Not shown to the customer');
      expect(card(html, t)).toContain('Remove price change');
    }
  });

  it('an option hidden with no change of the estimator (Best repeats Better) can still be priced: Change price, no Remove', () => {
    const html = render(draftWith(seededArea({ id: AREA_ID })));
    const best = card(html, 'Best');
    expect(best).toContain('Best is not shown to the customer: it is the same work as Better.');
    expect(best).toContain('Change price');
    expect(best).not.toContain('Remove price change');
  });
});

describe('F10 (OD1, OD6): the card the quote highlights says so, whichever option it is', () => {
  // Rim joist 150 sq ft: all three options cost the $1,500 minimum, so only Best is shown.
  const rim = seededArea({ id: AREA_ID, jobType: 'rim_joist', name: 'Rim', sqft: 150 });

  it('no pick, only Best shown: Best is the default and is highlighted on the quote', () => {
    const draft = draftWith(rim);
    expect(priceOf(draft).options.map((o) => o.tier)).toEqual(['best']);
    const best = card(render(draft), 'Best');
    expect(best).toContain('Recommended (default)');
    expect(best).toContain('Highlighted on the quote');
  });

  it('Better picked but not shown: Best is highlighted, and the card says the pick is not shown (not "default")', () => {
    const best = card(render(draftWith(rim, { selectedTier: 'better' })), 'Best');
    expect(best).toContain('Recommended (your pick is not shown)');
    expect(best).not.toContain('(default)');
    expect(best).toContain('Highlighted on the quote');
  });
});

describe('flow-B12: "Change the price" opens that option\'s price editor', () => {
  it('with editPrice, the Good card opens with Customer price (the box EstimateEditor focuses, option-good-price)', () => {
    const draft = draftWith(seededArea({ id: AREA_ID }), { overrides: { good: { price: 3500, reason: 'Two hatches' } } });
    const good = card(render(draft, 'good'), 'Good')!;
    expect(good).toContain('Customer price');
    expect(good).toContain('id="option-good-price"');
    expect(good).toContain('value="3500"');
    // Other cards, and the step opened any other way, show no editor.
    expect(card(render(draft, 'good'), 'Better')).not.toContain('Customer price');
    expect(render(draft)).not.toContain('Customer price');
    expect(fixElementId({ step: 'options', tier: 'good', edit: 'price' })).toBe('option-good-price');
    expect(fixElementId({ step: 'options', tier: 'good' })).toBe('option-good');
  });
});
