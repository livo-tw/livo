import { describe, expect, it } from 'vitest';
import { jaroWinkler, nameTokens, normalizeName, rankSlackMatches, slackMatchScore, SLACK_MATCH_THRESHOLD } from '@/lib/slackMatch';

const member = (name: string, email = '') => ({ name, email });
const slack = (name: string, email = '', extra: { realName?: string; handle?: string } = {}) => ({ name, email, ...extra });
const likely = (score: number) => score >= SLACK_MATCH_THRESHOLD;

describe('Slack account similarity', () => {
  it('normalizes case, accents, spacing and punctuation, and splits CJK by character', () => {
    expect(normalizeName('  Nora.Kemp ')).toBe('norakemp');
    expect(normalizeName('José Núñez')).toBe('josenunez');
    expect(nameTokens('王小明 Nora.Kemp camelCase')).toEqual(['王', '小', '明', 'nora', 'kemp', 'camel', 'case']);
    expect(nameTokens('김민수')).toEqual(['김', '민', '수']);
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('', 'x')).toBe(0);
  });

  it.each([
    ['same words, other separators', member('Nora Kemp', 'nora@example.com'), slack('nora.kemp', 'nk@example.org')],
    ['same words, other order', member('Kemp Nora'), slack('Nora Kemp')],
    ['initial + surname email', member('Nora Kemp', 'x@example.com'), slack('Y', 'nkemp@example.org')],
    ['email local parts that differ by a few letters', member('Kamd', 'kamdborp@example.com'), slack('kamdbard', 'kamdbard@example.org')],
    ['given name as Slack display name', member('Nora Kemp'), slack('Nora')],
    ['real name behind a nickname', member('Nora Kemp'), slack('Nova', '', { realName: 'Nora Kemp' })],
    ['CJK given name', member('王小明'), slack('小明')],
    ['CJK name with pinyin email', member('王小明', 'xiaoming.kemp@example.com'), slack('Xiaoming Kemp', 'xm@example.org')],
    ['accents', member('José Núñez'), slack('jose.nunez')],
    ['identical email', member('A', 'same@example.com'), slack('B', 'SAME@example.com')],
  ])('treats %s as a likely match', (_label, person, account) => {
    expect(likely(slackMatchScore(person, account))).toBe(true);
  });

  it.each([
    ['a different first name', member('Nora Kemp', 'nora@example.com'), slack('Nova', 'nova@example.org')],
    ['only the same surname', member('Nora Kemp', 'x@example.com'), slack('Kemp', 'zz@example.org')],
    ['a near surname', member('Nora Kemp', 'x@example.com'), slack('Nemp', 'nemp@example.org')],
    ['one CJK character apart', member('王小明'), slack('王大明')],
    ['a name hidden inside another', member('Ann'), slack('Joanna')],
    ['an unrelated person', member('Admin Self', 'self@example.com'), slack('Slack Person', 'person@example.org')],
  ])('does not suggest %s', (_label, person, account) => {
    expect(likely(slackMatchScore(person, account))).toBe(false);
  });
});

describe('ranking Slack accounts for a member', () => {
  const people = [slack('Bob', 'bob@example.org'), slack('Nova', 'nova@example.org'), slack('Nora', 'no@example.org'),
    slack('nora.kemp', 'kemp.n@example.org'), slack('Carol', 'carol@example.org')];

  it('puts at most three close matches first, best first, and keeps everyone else in order', () => {
    const { suggested, rest } = rankSlackMatches(member('Nora Kemp', 'nk@example.com'), people);
    expect(suggested.map(user => user.name)).toEqual(['nora.kemp', 'Nora']);
    expect(rest.map(user => user.name)).toEqual(['Bob', 'Nova', 'Carol']);
    const many = Array.from({ length: 5 }, (_, index) => slack(`Nora Kemp ${index}`, `nora.kemp${index}@example.org`));
    expect(rankSlackMatches(member('Nora Kemp'), many).suggested).toHaveLength(3);
  });

  it('keeps the normal list when nothing is clearly similar or no member is chosen', () => {
    expect(rankSlackMatches(member('Dana Lee', 'dana@example.com'), people)).toEqual({ suggested: [], rest: people });
    expect(rankSlackMatches(null, people)).toEqual({ suggested: [], rest: people });
  });

  it('ranks exact names above lookalikes and leaves names that only share a prefix out', () => {
    const { suggested, rest } = rankSlackMatches(member('Michael Chen', 'michael.chen@example.com'),
      [slack('Michelle', 'michelle@example.org'), slack('Michael', 'mike@example.org'), slack('Michael Chen', 'mc@example.org')]);
    expect(suggested.map(user => user.name)).toEqual(['Michael Chen', 'Michael']);
    expect(rest.map(user => user.name)).toEqual(['Michelle']);
  });
});
