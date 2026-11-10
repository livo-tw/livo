import type { QaPersonProfile } from './domain';

type Person = { name: string; avatar?: string; color?: string; jobTitle?: string; isExternal?: boolean };
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

/** QA presentation only. Never write these defaults into a member or actor. */
export function qaPersonDisplay(person: Person) {
  return {
    name: person.name,
    avatar: text(person.avatar) || Array.from(person.name.trim())[0] || '?',
    color: text(person.color) || '#64748b',
    jobTitle: text(person.jobTitle) || (person.isExternal === true ? 'QA' : ''),
  };
}

export function qaScopedProfile(profiles: Record<string, QaPersonProfile> | undefined, id: string | null | undefined): QaPersonProfile | undefined {
  if (!id || !profiles || !Object.prototype.hasOwnProperty.call(profiles, id)) return;
  const person = profiles[id];
  return person && typeof person === 'object' && !Array.isArray(person) && typeof person.name === 'string' && person.name.trim() ? person : undefined;
}
