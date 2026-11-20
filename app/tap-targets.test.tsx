// Tap targets of at least 48 px (components/daymark/Button.tsx) in the three places review B
// flow-B11 measured below it on a 390 px phone: the Areas step's "Use 1,200" (71x21), the approval
// queue's customer link (107x24) and the customer quote's estimator email link (100x20). The e2e
// small-target scan measures them in the browser; here each is checked for the 48 px floor class.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalQueue, type QueueItem } from '@/app/estimates/ApprovalQueue';
import { MeasureButton } from '@/app/field/AreasStep';
import { ContactCard } from '@/app/q/[token]/parts';
import { newMeasurement } from '@/lib/measure/measure';

vi.mock('server-only', () => ({}));
// Approve and Decline refresh the page through the app router, which a static render has not.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) }));

/** The opening tag of the element whose text is `text`, with its class list. */
function tagFor(html: string, text: string): string {
  const at = html.indexOf(`>${text}<`);
  expect(at, `"${text}" in the markup`).toBeGreaterThan(-1);
  const open = html.lastIndexOf('<', at);
  return html.slice(open, at + 1);
}
const floor48 = (tag: string) => /(^|\s|")min-h-12(\s|")/.test(tag) || /min-h-\[var\(--ctl-h/.test(tag);

describe('48 px tap targets (review B flow-B11)', () => {
  it('Areas step: "Use 1,200" under "Square feet don\'t match the measurement" is a 48 px button', () => {
    const sized = { ...newMeasurement('attic'), shape: { kind: 'rect' as const, dims: { A: '40', B: '30' } } };
    const html = renderToStaticMarkup(createElement(MeasureButton, { measurement: sized, sqft: 1000, onOpen: () => {}, onUseMeasured: () => {} }));
    const tag = tagFor(html, 'Use 1,200');
    expect(tag.startsWith('<button'), tag).toBe(true);
    expect(floor48(tag), tag).toBe(true);
  });

  it('approval queue: the customer link is at least 48 px tall', () => {
    const item = {
      id: 'a1',
      estimateId: 'e1',
      customer: 'Pat Lee',
      address: '1 Main St, Springfield',
      tier: 'better',
      price: 4000,
      modelPrice: 4500,
      belowFloor: false,
      requester: 'Sam Rivera',
      requestedBy: 'u2',
      requestedAt: '2026-11-19T12:00:00Z',
      note: null,
    } as QueueItem;
    const html = renderToStaticMarkup(createElement(ApprovalQueue, { items: [item], role: 'owner', userId: 'u1' }));
    const tag = tagFor(html, 'Pat Lee');
    expect(tag.startsWith('<a'), tag).toBe(true);
    expect(floor48(tag), tag).toBe(true);
  });

  it("customer quote: the estimator's email link is at least 48 px tall", () => {
    const html = renderToStaticMarkup(
      createElement(ContactCard, { estimator: { name: 'Sam Rivera', email: 'sam@example.com' }, branding: null } as never),
    );
    const tag = tagFor(html, 'sam@example.com');
    expect(tag.startsWith('<a'), tag).toBe(true);
    expect(floor48(tag), tag).toBe(true);
  });
});
