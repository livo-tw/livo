// The admin's pasted / uploaded "name, email" list.
import { describe, it, expect } from 'vitest';
import { accountListTemplate, parseAccountList } from '@/lib/jiraAccountMapping';

describe('parseAccountList', () => {
  it('reads comma, tab and semicolon separated lines and skips a header row', () => {
    const res = parseAccountList('名字,Email\nAvery Quinn, avery@example.com\nJordan Blake\tjordan@example.com\nRiley Park; riley@example.com\n');
    expect(res.accounts.map(({ name, email }) => [name, email])).toEqual([
      ['Avery Quinn', 'avery@example.com'],
      ['Jordan Blake', 'jordan@example.com'],
      ['Riley Park', 'riley@example.com'],
    ]);
    expect(res.skipped).toEqual([]);
  });

  it('handles quotes, full-width separators and "Name <email>"', () => {
    const res = parseAccountList('"Quinn, Avery",avery@example.com\n溫子晴，wen@example.com\nKai Lin <kai@example.com>\n');
    expect(res.accounts.map(({ name, email }) => [name, email])).toEqual([
      ['Quinn, Avery', 'avery@example.com'],
      ['溫子晴', 'wen@example.com'],
      ['Kai Lin', 'kai@example.com'],
    ]);
  });

  it('reports lines without an email (after the first line)', () => {
    const res = parseAccountList('Avery Quinn,avery@example.com\nJordan Blake\n\n,lonely@example.com\n');
    expect(res.accounts).toHaveLength(1);
    expect(res.skipped).toEqual([
      { line: 2, text: 'Jordan Blake' },
      { line: 4, text: ',lonely@example.com' },
    ]);
  });

  it('builds a fill-in template the parser reads back', () => {
    const csv = accountListTemplate(['名字', 'Email'], ['Avery Quinn', 'Quinn, "A"']);
    expect(csv).toBe('\uFEFF名字,Email\nAvery Quinn,\n"Quinn, ""A""",\n');
    expect(parseAccountList(csv.replace('Avery Quinn,', 'Avery Quinn,avery@example.com')).accounts).toEqual([
      { name: 'Avery Quinn', email: 'avery@example.com', line: 2 },
    ]);
  });
});
