// What the sign-in page says when something goes wrong, in plain words. Links into /login carry a
// short code (?error=link-expired), never the message itself, so nobody can put their own words
// on the page; an unknown code gets a general message.

export const LOGIN_ERRORS = {
  'link-expired': 'That sign-in link has expired or was already used. Ask for a new code below.',
  'demo-failed': 'The demo sign-in didn’t work. Try again, or sign in with your email.',
} as const;
export type LoginErrorCode = keyof typeof LOGIN_ERRORS;

const UNKNOWN = 'Sign-in didn’t work. Ask for a new code below.';

/** The message for a ?error= code, or null when there is none. */
export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : UNKNOWN;
}

/** Plain words for an error from sending the code (never the raw technical text). */
export function sendCodeErrorMessage(raw: string, online: boolean): string {
  if (!online || /failed to fetch|network|load failed/i.test(raw)) return 'No connection. Check your signal and try again.';
  if (/signups not allowed|not allowed for otp|user not found/i.test(raw)) return 'That email is not on the team. Ask the owner to invite you.';
  if (/rate limit|security purposes|too many/i.test(raw)) return 'A code was sent a moment ago. Wait a minute, then ask for a new one.';
  if (/invalid.*email|email.*invalid/i.test(raw)) return 'Check the email address and try again.';
  return 'We couldn’t send the code. Try again in a minute.';
}

/** Plain words for an error from checking the code. */
export function verifyErrorMessage(raw: string, online: boolean): string {
  if (!online || /failed to fetch|network|load failed/i.test(raw)) return 'No connection. Check your signal and try again.';
  return 'That code did not work. Check it or send a new one.';
}
