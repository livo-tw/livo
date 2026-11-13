import { accountOf, typedMentions, usableMentionPerson, withoutPickedMentionLabels, type MentionPerson } from './mentionMatching';
import { compareMemberOrder } from './department';

export { typedMentions, type MentionPerson } from './mentionMatching';

/**
 * Search names and e-mail accounts while preserving the team management order.
 * Inactive members are not offered.
 */
export function mentionSuggestions<T extends MentionPerson>(members: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  const rank = (person: T): number => {
    if (!q) return 0;
    const name = person.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return accountOf(person).includes(q) ? 2 : -1;
  };
  return members.filter(usableMentionPerson).map(person => ({ person, rank: rank(person) })).filter(row => row.rank >= 0)
    .sort((a, b) => compareMemberOrder(a.person, b.person)).map(row => row.person);
}

/** Readable text of editor HTML, entities decoded (mentions read "@Name"). */
export function mentionText(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]*>/g, ' ');
  // Block ends become spaces so "<p>@Ann</p><p>Hi</p>" does not read "@AnnHi".
  const doc = new DOMParser().parseFromString(html.replace(/<\/(p|div|li|h[1-6])>|<br\s*\/?>/gi, ' $&'), 'text/html');
  return (doc.body.textContent || '').replace(/\u00a0/g, ' ');
}

/** Ids picked from the mention list (the editor stores them as data-id). */
export function pickedMentionIds(html: string): string[] {
  return [...new Set(Array.from(html.matchAll(/data-id="([^"]+)"/g), match => match[1]))];
}

/** Everyone a comment or text mentions, picked or typed, each once. */
export function mentionedMembers<T extends MentionPerson>(html: string, members: T[]): T[] {
  const byId = new Map(members.filter(usableMentionPerson).map(person => [person.id, person]));
  const picked = pickedMentionIds(html).map(id => byId.get(id)).filter((person): person is T => !!person);
  const all = new Map(picked.map(person => [person.id, person]));
  for (const person of typedMentions(mentionText(withoutPickedMentionLabels(html)), members)) all.set(person.id, person);
  return [...all.values()];
}
