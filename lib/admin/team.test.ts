import { describe, expect, it } from 'vitest';
import { inviteForm, isEmailTakenError, memberForm, pinMemberForm, pinNameTaken, resetPinForm, selfEditError } from './team';

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

describe('adding a person who signs in with a PIN', () => {
  it('needs a name, a role and a 4-digit PIN', () => {
    expect(pinMemberForm.parse({ full_name: ' Nell Crew ', role: 'crew', pin: ' 1234 ' })).toEqual({ full_name: 'Nell Crew', role: 'crew', pin: '1234' });
    for (const pin of ['123', '12345', '12a4', '', undefined]) {
      const r = pinMemberForm.safeParse({ full_name: 'Nell', role: 'crew', pin });
      expect(r.success, String(pin)).toBe(false);
    }
    expect(pinMemberForm.safeParse({ full_name: 'Nell', role: 'crew', pin: '12a4' }).error?.issues[0]?.message).toBe('The PIN must be 4 digits (0 to 9)');
    expect(pinMemberForm.safeParse({ full_name: '', role: 'crew', pin: '1234' }).success).toBe(false);
    expect(pinMemberForm.safeParse({ full_name: 'Nell', role: 'boss', pin: '1234' }).success).toBe(false);
  });

  it('resets a PIN for one person', () => {
    expect(resetPinForm.parse({ id: ID, pin: '1234' })).toEqual({ id: ID, pin: '1234' });
    expect(resetPinForm.safeParse({ id: 'x', pin: '1234' }).success).toBe(false);
    expect(resetPinForm.safeParse({ id: ID, pin: '99' }).success).toBe(false);
  });

  it('refuses a second listed person with the same name, case and spaces aside', () => {
    expect(pinNameTaken(['Nell Crew', 'Oscar Office'], ' nell   CREW ')).toBe(true);
    expect(pinNameTaken(['Nell Crew'], 'Nell C.')).toBe(false);
    expect(pinNameTaken([], 'Nell Crew')).toBe(false);
  });
});
