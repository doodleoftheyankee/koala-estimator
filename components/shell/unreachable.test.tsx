// /unreachable (L36) offers the phone's own copy of the app only when the phone has one (review B
// flow-B8): with no saved copy the button led back to /unreachable.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnreachableState } from './StatePages';

describe('UnreachableState', () => {
  it('does not offer "Open the estimates on this phone" before it knows the phone has a copy', () => {
    const html = renderToStaticMarkup(<UnreachableState next="/field" phoneApp={{ href: '/field', label: 'Open the estimates on this phone' }} />);
    expect(html).toContain('Try again');
    expect(html).not.toContain('Open the estimates on this phone');
  });
});
