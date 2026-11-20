import { afterEach, describe, expect, it } from 'vitest';
import { serverEnv } from './env';

const saved = process.env.QUOTE_FROM_EMAIL;
afterEach(() => {
  if (saved === undefined) delete process.env.QUOTE_FROM_EMAIL;
  else process.env.QUOTE_FROM_EMAIL = saved;
});

// Review B flow-B7, owner decision OD12: with QUOTE_FROM_EMAIL unset, quote emails come from the
// brand, never one franchise's name (hard rule 3).
describe('the quote email sender', () => {
  it('defaults to Koala Insulation', () => {
    delete process.env.QUOTE_FROM_EMAIL;
    expect(serverEnv.quoteFromEmail()).toBe('Koala Insulation <onboarding@resend.dev>');
  });
  it('is the deployment\'s own when set', () => {
    process.env.QUOTE_FROM_EMAIL = 'Koala Insulation <quotes@example.com>';
    expect(serverEnv.quoteFromEmail()).toBe('Koala Insulation <quotes@example.com>');
  });
});

// Sign in with a name and PIN: off unless the server has its own PIN_SECRET.
describe('the PIN secret', () => {
  const was = process.env.PIN_SECRET;
  afterEach(() => {
    if (was === undefined) delete process.env.PIN_SECRET;
    else process.env.PIN_SECRET = was;
  });
  it('is unset (PIN sign-in off) when missing or blank', () => {
    delete process.env.PIN_SECRET;
    expect(serverEnv.pinSecret()).toBeNull();
    process.env.PIN_SECRET = '   ';
    expect(serverEnv.pinSecret()).toBeNull();
  });
  it("is the deployment's own when set", () => {
    process.env.PIN_SECRET = ' a-long-random-string ';
    expect(serverEnv.pinSecret()).toBe('a-long-random-string');
  });
});
