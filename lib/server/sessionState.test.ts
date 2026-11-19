import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { authErrorState, profileReadState, UNREACHABLE_BODY, unreachableHref } from './sessionState';

describe('a database that cannot be reached is not a sign-out (L36, RF-04, UX-05)', () => {
  it('the sign-in check: no answer or a server error is "unreachable"; anything else is signed out', () => {
    expect(authErrorState(new AuthRetryableFetchError('fetch failed', 0))).toBe('unreachable');
    expect(authErrorState(new AuthRetryableFetchError('Service Unavailable', 503))).toBe('unreachable');
    expect(authErrorState({ name: 'AuthUnknownError', status: 500, message: 'boom' })).toBe('unreachable');
    expect(authErrorState(new AuthSessionMissingError())).toBe('signed_out');
    expect(authErrorState(new AuthApiError('invalid JWT', 401, 'bad_jwt'))).toBe('signed_out');
    expect(authErrorState(null)).toBe('signed_out');
  });

  it("the profile read: no answer or a server error is 'unreachable'; a refused token is signed out", () => {
    expect(profileReadState(0)).toBe('unreachable'); // fetch failed
    expect(profileReadState(503)).toBe('unreachable'); // the gateway: PostgREST is down
    expect(profileReadState(500)).toBe('unreachable');
    expect(profileReadState(401)).toBe('signed_out');
    expect(profileReadState(403)).toBe('signed_out');
  });

  it('the page it sends people to keeps where they were going, on this site only', () => {
    expect(unreachableHref('/field?e=1')).toBe('/unreachable?next=%2Ffield%3Fe%3D1');
    expect(unreachableHref('//evil.example/x')).toBe('/unreachable?next=%2F');
    expect(unreachableHref('https://evil.example/')).toBe('/unreachable?next=%2F');
    expect(unreachableHref(null)).toBe('/unreachable?next=%2F');
  });

  it('APIs answer 503 with one plain sentence', () => {
    expect(UNREACHABLE_BODY).toEqual({ error: 'unreachable', message: "Can't reach Koala right now. Your work is saved. Try again in a minute." });
  });
});
