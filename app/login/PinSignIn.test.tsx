// The sign-in page's names: each listed person is one big button with "First · Role" and nothing
// else (no email, no login address); the PIN pad opens after a tap (checked in the e2e flow).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PinSignIn } from './PinSignIn';

describe('the names on the sign-in page', () => {
  it('shows one big button per person, labelled "First · Role", and no PIN pad yet', () => {
    const html = renderToStaticMarkup(
      <PinSignIn
        people={[
          { id: '0a000000-0000-4000-8000-000000000002', label: 'Oren · Office' },
          { id: '0a000000-0000-4000-8000-000000000001', label: 'Nina · Crew' },
        ]}
        next="/"
      />,
    );
    expect(html).toContain('>Tap your name<');
    const buttons = [...html.matchAll(/<button[^>]*class="([^"]*)"[^>]*>(.*?)<\/button>/g)];
    expect(buttons.map((b) => b[2]!.replace(/<[^>]+>/g, ''))).toEqual(['Oren · Office', 'Nina · Crew']);
    for (const b of buttons) expect(b[1]).toContain('min-h-16'); // 64 px: big enough for a gloved thumb
    expect(html).not.toContain('PIN pad');
    expect(html).not.toContain('0a000000'); // the ids are not shown
  });
});
