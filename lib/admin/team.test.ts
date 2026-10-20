import { describe, expect, it } from 'vitest';
import { inviteForm, isEmailTakenError, memberForm, selfEditError } from './team';

const ID = '8f14e45f-ceea-467f-a8f6-3b3a0c6c2b10';

describe('inviteForm', () => {
  it('normalizes email and requires a role', () => {
    expect(inviteForm.parse({ full_name: ' Pat Doe ', email: ' Pat@Example.COM ', role: 'estimator' })).toEqual({
      full_name: 'Pat Doe',
      email: 'pat@example.com',
      role: 'estimator',
    });
    expect(inviteForm.safeParse({ full_name: 'Pat', email: 'nope', role: 'estimator' }).success).toBe(false);
    expect(inviteForm.safeParse({ full_name: 'Pat', email: 'p@x.com', role: 'admin' }).success).toBe(false);
    expect(inviteForm.safeParse({ full_name: '', email: 'p@x.com', role: 'crew' }).success).toBe(false);
  });
});

describe('memberForm', () => {
  it('parses role and active toggle', () => {
    expect(memberForm.parse({ id: ID, role: 'office', active: 'false' })).toEqual({ id: ID, role: 'office', active: false });
  });
});

describe('isEmailTakenError', () => {
  it('recognizes Supabase duplicate-email errors', () => {
    expect(isEmailTakenError({ code: 'email_exists', message: 'x' })).toBe(true);
    expect(isEmailTakenError({ message: 'A user with this email address has already been registered' })).toBe(true);
    expect(isEmailTakenError({ message: 'Rate limit exceeded' })).toBe(false);
    expect(isEmailTakenError(null)).toBe(false);
  });
});

describe('selfEditError', () => {
  it('blocks self-demotion and self-deactivation only', () => {
    expect(selfEditError(ID, { id: ID, role: 'office', active: true })).toMatch(/own role/);
    expect(selfEditError(ID, { id: ID, role: 'owner', active: false })).toMatch(/deactivate/);
    expect(selfEditError(ID, { id: ID, role: 'owner', active: true })).toBeNull();
    expect(selfEditError(ID, { id: 'other', role: 'crew', active: false })).toBeNull();
  });
});
