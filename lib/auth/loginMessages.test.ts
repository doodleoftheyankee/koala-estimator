import { describe, expect, it } from 'vitest';
import { LOGIN_ERRORS, loginErrorMessage, sendCodeErrorMessage, verifyErrorMessage } from './loginMessages';

describe('sign-in messages', () => {
  it('shows only known codes, never text from the link', () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage('')).toBeNull();
    expect(loginErrorMessage('link-expired')).toBe(LOGIN_ERRORS['link-expired']);
    const injected = loginErrorMessage('Call 555-0100 to claim your prize');
    expect(injected).not.toContain('555');
    expect(injected).toMatch(/Sign-in didn’t work/);
    expect(loginErrorMessage('toString')).not.toBeNull(); // not a prototype key
    expect(loginErrorMessage('toString')).toMatch(/Sign-in didn’t work/);
  });

  it('turns technical errors into plain words', () => {
    expect(sendCodeErrorMessage('Failed to fetch', true)).toBe('No connection. Check your signal and try again.');
    expect(sendCodeErrorMessage('anything', false)).toBe('No connection. Check your signal and try again.');
    expect(sendCodeErrorMessage('Signups not allowed for otp', true)).toBe('That email is not on the team. Ask the owner to invite you.');
    expect(sendCodeErrorMessage('For security purposes, you can only request this after 37 seconds.', true)).toMatch(/Wait a minute/);
    expect(sendCodeErrorMessage('Database error saving new user', true)).toBe('We couldn’t send the code. Try again in a minute.');
    expect(verifyErrorMessage('Token has expired or is invalid', true)).toBe('That code did not work. Check it or send a new one.');
    expect(verifyErrorMessage('Failed to fetch', true)).toMatch(/No connection/);
  });
});
