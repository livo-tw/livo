// People in the CSV → LIVO members (existing / activate / new login / name only).
import { describe, it, expect } from 'vitest';
import {
  isPlaceholderEmail,
  isValidEmail,
  normalizeEmail,
  planMembers,
  summarizePeople,
  type EmailOwner,
  type ExistingMember,
  type JiraPerson,
  type MemberPlanInput,
} from '../../../worker/src/functions/jiraCsv';

const person = (name: string, key = name.toLowerCase()): JiraPerson => ({ key, name, roles: ['assignee'], issueCount: 1 });

const existing: ExistingMember[] = [
  { id: 'm-1', name: 'Avery Quinn', email: 'avery@example.com', role: 'member' },
  { id: 'u10', name: 'Jordan Blake', email: 'u10@import.invalid', role: 'member' },
  { id: 'u11', name: 'Casey Admin', email: 'u11@import.invalid', role: 'admin' },
];

function plan(partial: Partial<MemberPlanInput>) {
  let n = 20;
  return planMembers({
    people: [],
    existing,
    accounts: [],
    emailOwners: {},
    callerIsSuperAdmin: false,
    newMemberId: () => `u${n++}`,
    ...partial,
  });
}

describe('email helpers', () => {
  it('normalizes and validates', () => {
    expect(normalizeEmail('  Riley@Example.COM ')).toBe('riley@example.com');
    expect(normalizeEmail('ｒｉｌｅｙ＠example.com')).toBe('riley@example.com');
    expect(isValidEmail('riley@example.com')).toBe(true);
    expect(isValidEmail('riley@example')).toBe(false);
    expect(isValidEmail('riley example.com')).toBe(false);
    expect(isValidEmail('u10@import.invalid')).toBe(false);
    expect(isPlaceholderEmail('u10@import.invalid')).toBe(true);
    expect(isPlaceholderEmail('')).toBe(true);
    expect(isPlaceholderEmail('avery@example.com')).toBe(false);
  });
});

describe('planMembers', () => {
  it('reuses existing members by name and creates the rest name-only (no list)', () => {
    const res = plan({ people: [person('Avery Quinn'), person(' jordan  blake ', 'jordan blake'), person('Riley Park')] });
    expect(res.errors).toEqual([]);
    expect(res.plans['avery quinn']).toEqual({ kind: 'existing', memberId: 'm-1', memberName: 'Avery Quinn', hasLogin: true, matchedBy: 'name' });
    expect(res.plans['jordan blake']).toEqual({ kind: 'existing', memberId: 'u10', memberName: 'Jordan Blake', hasLogin: false, matchedBy: 'name' });
    expect(res.plans['riley park']).toEqual({ kind: 'new_name_only', memberId: 'u20' });
  });

  it('activates a name-only member and creates new logins from the list', () => {
    const res = plan({
      people: [person('Jordan Blake'), person('Riley Park')],
      accounts: [
        { name: 'Jordan Blake', email: 'Jordan@Example.com' },
        { name: 'Riley Park', email: 'riley@example.com' },
      ],
    });
    expect(res.errors).toEqual([]);
    expect(res.plans['jordan blake']).toEqual({ kind: 'activate', memberId: 'u10', memberName: 'Jordan Blake', email: 'jordan@example.com' });
    expect(res.plans['riley park']).toEqual({ kind: 'new_account', memberId: 'u20', email: 'riley@example.com' });
  });

  it('links a person to the member who already owns the email', () => {
    const owners: Record<string, EmailOwner> = {
      'avery@example.com': { memberId: 'm-1', name: 'Avery Quinn', sameWorkspace: true, hasLogin: true },
    };
    const res = plan({ people: [person('A. Quinn', 'a. quinn')], accounts: [{ name: 'A. Quinn', email: 'avery@example.com' }], emailOwners: owners });
    expect(res.errors).toEqual([]);
    expect(res.plans['a. quinn']).toEqual({ kind: 'existing', memberId: 'm-1', memberName: 'Avery Quinn', hasLogin: true, matchedBy: 'email' });
  });

  it('blocks duplicate, conflicting, invalid and foreign emails', () => {
    const owners: Record<string, EmailOwner> = {
      'taken@example.com': { memberId: '', name: '', sameWorkspace: false, hasLogin: true },
    };
    const res = plan({
      people: [person('Riley Park'), person('Sam Lee'), person('Kim Wu'), person('Lee Ho'), person('Max Fu')],
      accounts: [
        { name: 'Riley Park', email: 'shared@example.com' },
        { name: 'Sam Lee', email: 'shared@example.com' },
        { name: 'Kim Wu', email: 'kim@example.com' },
        { name: 'Kim Wu', email: 'kim.wu@example.com' },
        { name: 'Lee Ho', email: 'not-an-email' },
        { name: 'Max Fu', email: 'taken@example.com' },
      ],
      emailOwners: owners,
    });
    expect(res.errors.map((e) => e.code)).toEqual(['duplicate_email', 'conflicting_emails', 'invalid_email', 'email_in_other_workspace']);
    expect(res.errors[0]).toMatchObject({ name: 'Sam Lee', email: 'shared@example.com', detail: 'Riley Park' });
    // people with a broken line get no plan, so the preview shows them as errors
    for (const key of ['sam lee', 'kim wu', 'lee ho', 'max fu']) expect(res.plans[key]).toBeUndefined();
    expect(res.plans['riley park']).toMatchObject({ kind: 'new_account', email: 'shared@example.com' });
  });

  it('never rewrites the email of a member who already has a login', () => {
    const res = plan({ people: [person('Avery Quinn')], accounts: [{ name: 'Avery Quinn', email: 'new@example.com' }] });
    expect(res.errors).toEqual([{ code: 'member_has_login', name: 'Avery Quinn', email: 'new@example.com', detail: 'avery@example.com' }]);
  });

  it('only a super admin may create the login of an admin', () => {
    const input = { people: [person('Casey Admin')], accounts: [{ name: 'Casey Admin', email: 'casey@example.com' }] };
    expect(plan(input).errors.map((e) => e.code)).toEqual(['requires_super_admin']);
    expect(plan({ ...input, callerIsSuperAdmin: true }).plans['casey admin']).toMatchObject({ kind: 'activate', memberId: 'u11' });
  });

  it('gives no login to a disabled member', () => {
    const res = plan({
      people: [person('Jordan Blake')],
      existing: existing.map((m) => (m.id === 'u10' ? { ...m, isActive: false } : m)),
      accounts: [{ name: 'Jordan Blake', email: 'jordan@example.com' }],
    });
    expect(res.errors).toEqual([{ code: 'member_inactive', name: 'Jordan Blake', email: 'jordan@example.com' }]);
    expect(res.plans['jordan blake']).toBeUndefined();
  });

  it('warns about names on the list that are not in the CSV', () => {
    const res = plan({ people: [person('Riley Park')], accounts: [{ name: 'Nobody Here', email: 'nobody@example.com' }] });
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([{ code: 'unknown_name', name: 'Nobody Here', email: 'nobody@example.com' }]);
  });

  it('summarizes the plan for the preview', () => {
    const people = [person('Avery Quinn'), person('Jordan Blake'), person('Riley Park'), person('Sam Lee')];
    const res = plan({
      people,
      accounts: [{ name: 'Jordan Blake', email: 'jordan@example.com' }, { name: 'Sam Lee', email: 'bad' }],
    });
    expect(summarizePeople(people, res, existing).map((p) => [p.name, p.plan, p.email])).toEqual([
      ['Avery Quinn', 'existing', 'avery@example.com'],
      ['Jordan Blake', 'activate', 'jordan@example.com'],
      ['Riley Park', 'new_name_only', undefined],
      ['Sam Lee', 'error', undefined],
    ]);
  });
});
