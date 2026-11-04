// Members imported from Jira without an email get `<member id>@import.invalid`
// (see placeholderEmail in worker/src/functions/jiraCsv.ts): they have a name
// but no login until an admin uses 「啟用帳號」.

const PLACEHOLDER_SUFFIX = '@import.invalid';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return !e || e.endsWith(PLACEHOLDER_SUFFIX);
}

/** The member fields mention matching needs. */
export interface MentionPerson { id: string; name: string; email?: string; isActive?: boolean; sortOrder?: number }

export const accountOf = (person: MentionPerson): string => isPlaceholderEmail(person.email) ? '' : (person.email || '').split('@')[0].trim().toLowerCase();
export const usableMentionPerson = (person: MentionPerson): boolean => person.isActive !== false && !!person.name?.trim();

/**
 * Members named after "@" in plain text: a mention typed or pasted instead of picked
 * from the list. Each "@" takes the longest member name or e-mail account that follows
 * it; a Latin name must end at a word boundary ("@Ann" is not "@Anna"), a CJK name may
 * run straight into the sentence. A name two members share is ambiguous and is skipped,
 * and an "@" inside an e-mail address is not a mention.
 */
export function typedMentions<T extends MentionPerson>(text: string, members: T[]): T[] {
  const people = members.filter(usableMentionPerson);
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

/** A picked mention's label may be stale. Match it only by its stored id. */
export function withoutPickedMentionLabels(html: string): string {
  return html.replace(/<span\b[^>]*\sdata-id="[\w-]{1,200}"[^>]*>[\s\S]*?<\/span\s*>/gi, ' ');
}
