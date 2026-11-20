import { describe, expect, it } from 'vitest';
import { reachUs } from './contact';

const branding = { company: 'Koala Insulation', license: null, phone: null, email: null, website: null, primaryColor: '#0f766e', logoUrl: null };
const estimator = { name: 'Sam Rivera', email: 'sam@example.com' };

// Owner decision OD12: never "call our office" without a number; point the customer to the office
// phone when there is one, else the estimator's own email (as the quote page does: OfficeContact).
describe('how a customer reaches us, in a sentence', () => {
  it('the office phone, else the estimator, else the office email, else the email that brought them', () => {
    expect(reachUs({ branding: { ...branding, phone: '5550100199' }, estimator })).toBe('call (555) 010-0199');
    expect(reachUs({ branding, estimator })).toBe('email Sam Rivera at sam@example.com');
    expect(reachUs({ branding: { ...branding, email: 'office@example.com' }, estimator: { name: 'Sam Rivera', email: null } })).toBe('email office@example.com');
    expect(reachUs({ branding, estimator: { name: 'Sam Rivera', email: null } })).toBe('reply to the email that brought you here');
  });

  it('the sign route says it that way instead of "call our office"', async () => {
    const fs = await import('node:fs');
    const route = fs.readFileSync('app/api/public/quotes/[token]/sign/route.ts', 'utf8');
    expect(route).not.toMatch(/our office/i);
    expect(route).toContain('reachUs(');
  });
});
