import { expect, it, vi } from 'vitest';
import { qaPersonSortOrder, sortExternalQaPeople, sortQaPeople } from '@/lib/qa/peopleOrder';
import { parseWorkspaceProfile } from '@/lib/qa/externalProfile';

vi.mock('@/lib/apiBase', () => ({ fnUrl: () => 'https://example.com/functions/v1/qa' }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));

it('keeps the internal team order and a separate external name order without moving inactive people', () => {
  const people = [
    { id: 'external-b', name: 'alpha', isExternal: true, sortOrder: -100, isActive: true },
    { id: 'internal-late', name: 'Alpha internal', sortOrder: 8, isActive: true },
    { id: 'external-a', name: 'Alpha', isExternal: true, sortOrder: 500, isActive: false },
    { id: 'internal-first', name: 'Zulu internal', sortOrder: 1, isActive: false },
    { id: 'internal-default-b', name: 'Alpha default', isActive: true },
    { id: 'internal-default-a', name: 'Zulu default', isActive: false },
  ];
  const before = JSON.stringify(people);
  expect(sortQaPeople(people).map(person => person.id)).toEqual([
    'internal-first', 'internal-late', 'internal-default-a', 'internal-default-b', 'external-a', 'external-b',
  ]);
  expect(JSON.stringify(people)).toBe(before);
  expect(sortQaPeople(people.map(person => ({ ...person, isActive: !person.isActive }))).map(person => person.id))
    .toEqual(sortQaPeople(people).map(person => person.id));
});

it('orders an external administration roster by lowercased name then id, regardless of active state', () => {
  expect(sortExternalQaPeople([
    { id: 'z', name: 'alpha', isActive: true }, { id: 'b', name: 'Zulu', isActive: true },
    { id: 'a', name: 'Alpha', isActive: false },
  ]).map(person => person.id)).toEqual(['a', 'z', 'b']);
});

it('uses the default team position for missing or invalid ordering metadata', () => {
  for (const value of [undefined, null, '1', NaN, Infinity, -Infinity]) expect(qaPersonSortOrder(value)).toBe(99);
  expect(qaPersonSortOrder(0)).toBe(0);
  expect(sortQaPeople([{ id: 'b', name: 'Alpha', sortOrder: NaN }, { id: 'a', name: 'Zulu' }]).map(person => person.id))
    .toEqual(['a', 'b']);
});

it('uses profile ordering metadata without inventing team positions from response indexes or exposing private fields', () => {
  const profile = parseWorkspaceProfile({ external: true, id: 'external-self', name: 'Example visitor', qaEnabled: true,
    projects: [], environments: [], members: [
      { id: 'external-z', name: 'Zulu', isActive: true, isExternal: true },
      { id: 'member-b', name: 'Alpha member', isActive: true, isExternal: false, sortOrder: 10, email: 'private@example.com', auth_id: 'private-login' },
      { id: 'member-a', name: 'Zulu member', isActive: false, isExternal: false, sortOrder: 2 },
      { id: 'external-a', name: 'alpha', isActive: false, isExternal: true },
      { id: 'historical', name: 'Historical label', isActive: false },
    ] });
  if (!profile.external) throw new Error('Expected external profile');
  expect(profile.members.map(person => person.id)).toEqual(['member-a', 'member-b', 'historical', 'external-a', 'external-z']);
  expect(profile.members.find(person => person.id === 'historical')).toMatchObject({ sortOrder: 99, isActive: false });
  expect(profile.members.find(person => person.id === 'historical')).not.toHaveProperty('isExternal');
  expect(profile.members.find(person => person.id === 'member-b')).toMatchObject({ email: '', sortOrder: 10, isExternal: false });
  expect(profile.members.find(person => person.id === 'member-b')).not.toHaveProperty('auth_id');
});
