/**
 * Ranks Slack accounts by how much they look like a LIVO member, so the owner's
 * manual-mapping picker can show likely matches first. Suggestions only: nothing
 * here binds an account.
 */
export type MatchMember = { name?: string | null; email?: string | null };
export type MatchSlackUser = { name?: string | null; email?: string | null; realName?: string | null; handle?: string | null };

/** Scores at or above this are shown as likely matches. */
export const SLACK_MATCH_THRESHOLD = 0.88;
const CJK_CLASS = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
const CJK = new RegExp(`[${CJK_CLASS}]`, 'u');
/** One CJK character, or a run of anything else. */
const CHUNK = new RegExp(`[${CJK_CLASS}]|[^${CJK_CLASS}]+`, 'gu');

/** Lower case, no accents, letters and digits only ("Nora  Kemp" and "nora.kemp" both become "norakemp"). */
export function normalizeName(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Words of a name or email local part; CJK text counts one character per token. */
export function nameTokens(value: string): string[] {
  return value.replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[^\p{L}\p{N}]+/u)
    .flatMap((word): string[] => normalizeName(word).match(CHUNK) || []);
}

/** The part before "@", without a "+tag". */
function emailLocal(email?: string | null): string {
  const local = (email || '').trim().split('@')[0] || '';
  return local.split('+')[0];
}

/** Jaro-Winkler similarity, 0..1. */
export function jaroWinkler(left: string, right: string): number {
  const a = [...left], b = [...right];
  if (!a.length || !b.length) return 0;
  if (left === right) return 1;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const matchedA = new Array<boolean>(a.length).fill(false), matchedB = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - window); j < Math.min(b.length, i + window + 1); j++) {
      if (matchedB[j] || a[i] !== b[j]) continue;
      matchedA[i] = matchedB[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;
  let transpositions = 0;
  for (let i = 0, j = 0; i < a.length; i++) {
    if (!matchedA[i]) continue;
    while (!matchedB[j]) j++;
    if (a[i] !== b[j]) transpositions++;
    j++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

type Spelling = { flat: string; tokens: string[]; exactOnly?: boolean };
const length = (value: string) => [...value].length;

/** A name as written, plus initial + surname forms ("nkemp", "kempn"...) that only count when equal. */
function spellings(value: string): Spelling[] {
  const tokens = nameTokens(value), flat = normalizeName(value);
  if (!flat) return [];
  const out: Spelling[] = [{ flat, tokens }];
  if (tokens.length >= 2 && !tokens.some(token => CJK.test(token))) {
    const first = tokens[0], last = tokens[tokens.length - 1];
    for (const extra of [first[0] + last, last + first[0], first + last[0], last + first]) out.push({ flat: extra, tokens: [extra], exactOnly: true });
  }
  return out;
}

function pairScore(left: Spelling, right: Spelling): number {
  const [short, long] = length(left.flat) <= length(right.flat) ? [left.flat, right.flat] : [right.flat, left.flat];
  if (length(short) < 2) return 0;
  if (short === long) return 1;
  if (left.exactOnly || right.exactOnly) return 0;
  const cjk = CJK.test(short), ratio = length(short) / length(long);
  let score = 0;
  // "nora" at the start of "norakemp", or "小明" at the end of "王小明". A Latin surname alone is weaker.
  if (length(short) >= (cjk ? 2 : 3)) {
    if (long.startsWith(short)) score = 0.8 + 0.2 * ratio;
    else if (long.endsWith(short)) score = (cjk ? 0.8 : 0.7) + 0.2 * ratio;
    // Jaro-Winkler is generous to a shared prefix on strings of different lengths ("michelle" / "michaelchen").
    score = Math.max(score, jaroWinkler(left.flat, right.flat) * (0.85 + 0.15 * ratio));
  }
  // Same words in another order or with other separators ("Kemp Nora" / "nora.kemp"); CJK by character.
  const words = (spelling: Spelling) => spelling.tokens.filter(token => length(token) >= 2 || CJK.test(token));
  const leftWords = words(left), pool = words(right), total = leftWords.length + pool.length;
  if (leftWords.length && pool.length) {
    let shared = 0;
    for (const word of leftWords) { const index = pool.indexOf(word); if (index >= 0) { shared++; pool.splice(index, 1); } }
    score = Math.max(score, 2 * shared / total);
  }
  return score;
}

/** How much a Slack account looks like a member, 0..1. */
export function slackMatchScore(member: MatchMember, slack: MatchSlackUser): number {
  const ours = [member.name, emailLocal(member.email)].filter((value): value is string => !!value?.trim()).flatMap(spellings);
  const theirs = [slack.name, slack.realName, slack.handle, emailLocal(slack.email)].filter((value): value is string => !!value?.trim())
    .map(value => ({ flat: normalizeName(value), tokens: nameTokens(value) })).filter(value => value.flat);
  let best = 0;
  for (const left of ours) for (const right of theirs) best = Math.max(best, pairScore(left, right));
  // Identical full email addresses are the strongest signal there is.
  if (member.email && slack.email && member.email.trim().toLocaleLowerCase() === slack.email.trim().toLocaleLowerCase()) best = 1;
  return Math.min(1, best);
}

/** Up to `limit` clearly similar accounts first (best first), then everyone else in their original order. */
export function rankSlackMatches<T extends MatchSlackUser>(member: MatchMember | null | undefined, users: T[], limit = 3): { suggested: T[]; rest: T[] } {
  if (!member) return { suggested: [], rest: users };
  const suggested = users.map((user, index) => ({ user, index, score: slackMatchScore(member, user) }))
    .filter(row => row.score >= SLACK_MATCH_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit).map(row => row.user);
  const picked = new Set(suggested);
  return { suggested, rest: users.filter(user => !picked.has(user)) };
}
