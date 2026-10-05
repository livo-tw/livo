import { isPlaceholderEmail } from '@/lib/memberEmail';

/** The member fields mention matching needs. */
export interface MentionPerson { id: string; name: string; email?: string; isActive?: boolean; sortOrder?: number }

const accountOf = (person: MentionPerson): string => isPlaceholderEmail(person.email) ? '' : (person.email || '').split('@')[0].trim().toLowerCase();
const usable = (person: MentionPerson): boolean => person.isActive !== false && !!person.name?.trim();

/**
 * Members offered after "@": names that start with the query first, then names that
 * contain it, then e-mail accounts that contain it, so "@irene" also finds a member
 * shown under another name. Inactive members are not offered.
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
  return members.filter(usable).map(person => ({ person, rank: rank(person) })).filter(row => row.rank >= 0)
    .sort((a, b) => a.rank - b.rank || (a.person.sortOrder ?? 0) - (b.person.sortOrder ?? 0)).map(row => row.person);
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

/**
 * Members named after "@" in plain text: a mention typed or pasted instead of picked
 * from the list. Each "@" takes the longest member name or e-mail account that follows
 * it; a Latin name must end at a word boundary ("@Ann" is not "@Anna"), a CJK name may
 * run straight into the sentence. A name two members share is ambiguous and is skipped,
 * and an "@" inside an e-mail address is not a mention.
 */
export function typedMentions<T extends MentionPerson>(text: string, members: T[]): T[] {
  const people = members.filter(usable);
  const found = new Map<string, T>();
  for (let at = text.indexOf('@'); at >= 0; at = text.indexOf('@', at + 1)) {
    if (at > 0 && /[\p{L}\p{N}._%+-]/u.test(text[at - 1])) continue;
    const rest = text.slice(at + 1).toLowerCase();
    let length = 0, matches: T[] = [];
    for (const person of people) {
      for (const key of new Set([person.name.trim().toLowerCase(), accountOf(person)])) {
        if (key.length < 2 || !rest.startsWith(key)) continue;
        if (/[\p{Script=Latin}\p{N}]$/u.test(key) && /^[\p{Script=Latin}\p{N}_]/u.test(rest.slice(key.length))) continue;
        if (key.length > length) { length = key.length; matches = [person]; }
        else if (key.length === length && !matches.includes(person)) matches.push(person);
      }
    }
    if (matches.length === 1) found.set(matches[0].id, matches[0]);
  }
  return [...found.values()];
}

/** Everyone a comment or text mentions, picked or typed, each once. */
export function mentionedMembers<T extends MentionPerson>(html: string, members: T[]): T[] {
  const byId = new Map(members.filter(usable).map(person => [person.id, person]));
  const picked = pickedMentionIds(html).map(id => byId.get(id)).filter((person): person is T => !!person);
  const all = new Map(picked.map(person => [person.id, person]));
  for (const person of typedMentions(mentionText(html), members)) all.set(person.id, person);
  return [...all.values()];
}
