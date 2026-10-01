// Jira CSV import — the parsing shared by the three importers
// (worker/src/functions/jiraCsv.ts, copied verbatim into the Docker functions).
// Fixtures are made-up exports: no real people, projects or companies.
import { describe, it, expect } from 'vitest';
import enCsv from './fixtures/en.csv?raw';
import cnCsv from './fixtures/zh-CN.csv?raw';
import twCsv from './fixtures/zh-TW.csv?raw';
import {
  mapPriority,
  mapStatus,
  parseAttachmentCell,
  parseCSV,
  parseJiraDate,
  parseJiraDateTime,
  parseJiraExport,
  personKey,
  planStatuses,
  statusNameKey,
  resolveColumns,
  textToHtml,
  type WorkspaceStatus,
} from '../../../worker/src/functions/jiraCsv';

type Parsed = Extract<ReturnType<typeof parseJiraExport>, { ok: true }>;

function parseOk(text: string, timeZone = 'Asia/Taipei'): Parsed {
  const res = parseJiraExport(text, { timeZone });
  if (!res.ok) throw new Error(`parse failed: ${JSON.stringify(res)}`);
  return res;
}

const issue = (p: Parsed, key: string) => {
  const found = p.issues.find((i) => i.key === key);
  if (!found) throw new Error(`no issue ${key}`);
  return found;
};

describe('header aliases', () => {
  it('matches English and Simplified Chinese names, ignoring case, spaces and full-width forms', () => {
    const cols = resolveColumns(['  summary ', 'ISSUE KEY', '状态', 'Status Category', '经办人 ID', 'Ｐｒｉｏｒｉｔｙ', 'Comment', 'Comment', '评论']);
    expect(cols.missing).toEqual([]);
    expect(cols.index.title).toBe(0);
    expect(cols.index.key).toBe(1);
    expect(cols.index.status).toBe(2);
    expect(cols.index.statusCategory).toBe(3);
    expect(cols.index.assigneeId).toBe(4);
    expect(cols.index.priority).toBe(5);
    expect(cols.all.comment).toEqual([6, 7, 8]);
  });

  it('does not treat a custom field called 评论 as a comment column', () => {
    const p = parseOk(cnCsv);
    expect(p.columns.all.comment).toHaveLength(3);
  });

  it('reports missing required columns with the accepted names and the columns it found', () => {
    const res = parseJiraExport('Title,Key,State\nA,NOVA-1,Open\n');
    expect(res.ok).toBe(false);
    // equality narrowing: the app tsconfig has strictNullChecks off, where `res.ok || …` does not narrow
    if (res.ok !== false || res.error !== 'missing_columns') throw new Error('expected missing_columns');
    expect(res.missing.map((m) => m.field)).toEqual(['title', 'key']);
    expect(res.missing[0].accepted).toEqual(['Summary', '摘要']);
    expect(res.missing[1].accepted).toEqual(['Issue key', '事务密钥']);
    expect(res.detected).toEqual(['Title', 'Key', 'State']);
  });

  it('refuses a CSV with a header row only', () => {
    expect(parseJiraExport('Summary,Issue key\n')).toEqual({ ok: false, error: 'no_data_rows' });
  });
});

describe('CSV parser', () => {
  it('keeps quoted commas, quotes and line breaks inside a cell', () => {
    const rows = parseCSV('\uFEFFa,b\r\n"x, ""y""","line 1\nline 2"\r\n');
    expect(rows).toEqual([['a', 'b'], ['x, "y"', 'line 1\nline 2']]);
  });
});

describe('status mapping', () => {
  it('status names win over the status category', () => {
    expect(mapStatus('不做了', '待办')).toBe('s7');
    expect(mapStatus('待驗收', '正在进行')).toBe('s3');
    expect(mapStatus('待討論確認', 'In Progress')).toBe('s4');
    expect(mapStatus('等待部署', '正在进行')).toBe('s5');
    expect(mapStatus('等待部屬', '正在进行')).toBe('s5'); // misspelling seen in real exports
    expect(mapStatus('已完成', '完成')).toBe('s6');
    expect(mapStatus("Won't Do", 'Done')).toBe('s7');
    expect(mapStatus('Reopened', 'To Do')).toBe('s1');
  });

  it('falls back to the status category (English and Chinese)', () => {
    expect(mapStatus('Ready for QA', 'In Progress')).toBe('s2');
    expect(mapStatus('Backlog review', 'To Do')).toBe('s1');
    expect(mapStatus('Shipped', 'Done')).toBe('s6');
    expect(mapStatus('自訂狀態', '正在进行')).toBe('s2');
    expect(mapStatus('自訂狀態', '完成')).toBe('s6');
  });

  it('maps common status names without a category', () => {
    expect(mapStatus('To Do')).toBe('s1');
    expect(mapStatus('in progress')).toBe('s2');
    expect(mapStatus('Done')).toBe('s6');
    expect(mapStatus('Closed')).toBe('s6');
    expect(mapStatus("Won't Do")).toBe('s7');
    expect(mapStatus('Won’t Do')).toBe('s7');
    expect(mapStatus('進行中')).toBe('s2');
    expect(mapStatus('待辦')).toBe('s1');
    expect(mapStatus('完成')).toBe('s6');
    expect(mapStatus('Something else')).toBe('s1');
    expect(mapStatus('')).toBe('s1');
  });
});

describe('priority mapping', () => {
  it('accepts English, the classic scheme and Chinese names', () => {
    expect(mapPriority('Highest')).toBe('highest');
    expect(mapPriority('Blocker')).toBe('highest');
    expect(mapPriority('critical')).toBe('high');
    expect(mapPriority('Major')).toBe('medium');
    expect(mapPriority('Trivial')).toBe('lowest');
    expect(mapPriority('最高')).toBe('highest');
    expect(mapPriority('高')).toBe('high');
    expect(mapPriority('中')).toBe('medium');
    expect(mapPriority('低')).toBe('low');
    expect(mapPriority('最低')).toBe('lowest');
    expect(mapPriority('')).toBe('medium');
    expect(mapPriority('Unknown')).toBe('medium');
  });
});

describe('dates', () => {
  it('converts Chinese and English Jira times from the given zone to UTC', () => {
    expect(parseJiraDateTime('15/九月/26 3:00 下午', 'Asia/Taipei')).toBe('2026-09-15T07:00:00Z');
    expect(parseJiraDateTime('15/Mar/24 10:30 AM', 'Asia/Taipei')).toBe('2024-03-15T02:30:00Z');
    expect(parseJiraDateTime('15/March/2024 10:30 pm', 'UTC')).toBe('2024-03-15T22:30:00Z');
    expect(parseJiraDateTime('15/3月/26 9:05 上午', 'Asia/Taipei')).toBe('2026-03-15T01:05:00Z');
  });

  it('handles 12 AM / 12 PM', () => {
    expect(parseJiraDateTime('01/Jan/25 12:00 AM', 'UTC')).toBe('2025-01-01T00:00:00Z');
    expect(parseJiraDateTime('01/Jan/25 12:30 PM', 'UTC')).toBe('2025-01-01T12:30:00Z');
    expect(parseJiraDateTime('01/一月/25 12:10 上午', 'UTC')).toBe('2025-01-01T00:10:00Z');
  });

  it('follows daylight saving time of the zone', () => {
    expect(parseJiraDateTime('15/Jan/24 9:00 AM', 'America/New_York')).toBe('2024-01-15T14:00:00Z');
    expect(parseJiraDateTime('15/Jul/24 9:00 AM', 'America/New_York')).toBe('2024-07-15T13:00:00Z');
  });

  it('accepts ISO dates; an explicit offset wins over the zone', () => {
    expect(parseJiraDateTime('2024-03-15T10:30:00.000+0800', 'UTC')).toBe('2024-03-15T02:30:00Z');
    expect(parseJiraDateTime('2024-03-15 10:30', 'Asia/Taipei')).toBe('2024-03-15T02:30:00Z');
    expect(parseJiraDate('2024-03-15T23:30:00-0500')).toBe('2024-03-15');
  });

  it('keeps calendar dates as written', () => {
    expect(parseJiraDate('15/九月/26 3:00 下午')).toBe('2026-09-15');
    expect(parseJiraDate('01/Sep/26 12:30 AM')).toBe('2026-09-01');
    expect(parseJiraDate('2026/9/1')).toBe('2026-09-01');
  });

  it('rejects impossible or unknown dates', () => {
    expect(parseJiraDate('31/Feb/24')).toBeNull();
    expect(parseJiraDate('15/Foo/24')).toBeNull();
    expect(parseJiraDate('03/15/2024')).toBeNull();
    expect(parseJiraDateTime('')).toBeNull();
  });
});

describe('attachments', () => {
  it('reads "time;uploader;file name;url" and takes the id from the URL', () => {
    expect(parseAttachmentCell('15/Mar/24 10:40 AM;5f01;a;b.png;https://x.example/rest/api/3/attachment/content/123', 'UTC')).toEqual({
      id: '123',
      fileName: 'a;b.png',
      uploadedAt: '2024-03-15T10:40:00Z',
      uploaderAccountId: '5f01',
    });
    expect(parseAttachmentCell('not an attachment')).toBeNull();
  });
});

describe('person names', () => {
  it('ignores surrounding spaces, case, full-width forms and spaces between CJK characters', () => {
    expect(personKey(' 溫子晴 ')).toBe(personKey('溫子晴'));
    expect(personKey('Ｋａｉ　Ｌｉｎ')).toBe(personKey('kai lin'));
    expect(personKey('柯　雨辰')).toBe(personKey('柯雨辰'));
    expect(personKey('Ann A')).not.toBe(personKey('AnnA'));
  });
});

describe('English export', () => {
  const p = parseOk(enCsv);

  it('reads every issue with its status, priority and dates', () => {
    expect(p.totalRows).toBe(4);
    expect(p.issues.map((i) => i.key)).toEqual(['NOVA-1', 'NOVA-2', 'NOVA-3', 'NOVA-4']);
    const story = issue(p, 'NOVA-2');
    expect(story.statusId).toBe('s6');
    expect(story.priority).toBe('highest');
    expect(story.created).toBe('2024-03-15');
    expect(story.createdAt).toBe('2024-03-15T02:30:00Z');
    expect(story.resolved).toBe('2024-03-18');
    expect(story.due).toBe('2024-03-20');
    expect(story.start).toBe('2024-03-14');
    expect(story.sprint).toBe('NOVA Sprint 2');
    expect(issue(p, 'NOVA-3').statusId).toBe('s2'); // custom status, category In Progress
    expect(issue(p, 'NOVA-4').statusId).toBe('s7');
    expect(p.sprintNames).toEqual(['NOVA Sprint 2']); // a row's last non-empty sprint cell
  });

  it('collects people with their roles, and comment authors through the account ids', () => {
    expect(p.people.map((x) => x.name)).toEqual(['Avery Quinn', 'Jordan Blake', 'Riley Park']);
    const avery = p.people.find((x) => x.name === 'Avery Quinn');
    expect(avery?.roles).toEqual(['assignee', 'reporter', 'creator', 'commenter']);
    const story = issue(p, 'NOVA-2');
    expect(story.comments).toHaveLength(2);
    expect(story.comments[0].authorKey).toBe(personKey('Avery Quinn'));
    expect(story.comments[0].createdAt).toBe('2024-03-16T03:20:00Z');
    expect(story.comments[1].content).toBe('Approved.\nShip it.');
    expect(p.unresolvedCommenters).toBe(0);
  });

  it('links the sub-task to its parent and leaves the epic link out', () => {
    expect(issue(p, 'NOVA-3').parentKey).toBe('NOVA-2');
    expect(issue(p, 'NOVA-2').parentKey).toBeNull();
    expect(issue(p, 'NOVA-2').jiraParentKey).toBe('NOVA-1');
    expect(p.hierarchy).toEqual({ linked: 1, epicChildren: 1, unlinked: 0 });
  });

  it('reads the attachment columns', () => {
    expect(p.attachmentCount).toBe(2);
    expect(issue(p, 'NOVA-2').attachments.map((a) => [a.id, a.fileName])).toEqual([
      ['20001', 'form-error.png'],
      ['20002', 'spec;v2.pdf'],
    ]);
  });

  it('turns wiki markup into HTML and resolves mentions', () => {
    const story = issue(p, 'NOVA-2');
    const html = textToHtml(story.comments[0].content, (id) =>
      p.accountPeople[id] === personKey('Jordan Blake') ? { name: 'Jordan Blake', memberId: 'u11' } : null
    );
    expect(html).toBe('<p>Looks good, <span class="mention" data-id="u11">@Jordan Blake</span> please review.</p>');
    const spec = textToHtml(story.description);
    expect(spec).toContain('<h2>Goal</h2>');
    expect(spec).toContain('<strong>email</strong>');
    expect(spec).toContain('[圖片: form-error.png]');
    expect(spec).toContain('<li>trim spaces</li>');
  });
});

describe('Simplified Chinese export', () => {
  const p = parseOk(cnCsv);

  it('handles the BOM, CRLF line endings and multi-line cells', () => {
    expect(p.totalRows).toBe(5);
    expect(issue(p, 'ORB-11').description).toBe('需求：\n# 状态筛选\n# 日期筛选');
    expect(issue(p, 'ORB-11').comments[1].content).toBe('收到\n明天看');
  });

  it('maps the translated system statuses and the custom Traditional Chinese ones', () => {
    expect(issue(p, 'ORB-10').statusId).toBe('s2'); // 正在进行
    expect(issue(p, 'ORB-11').statusId).toBe('s3'); // 待驗收
    expect(issue(p, 'ORB-12').statusId).toBe('s7'); // 不做了, category 待办
    expect(issue(p, 'ORB-13').statusId).toBe('s5'); // 等待部屬
    expect(issue(p, 'ORB-14').statusId).toBe('s6'); // 已完成
  });

  it('stores UTC+8 times as UTC and keeps the calendar dates', () => {
    const t = issue(p, 'ORB-11');
    expect(t.created).toBe('2026-09-15');
    expect(t.createdAt).toBe('2026-09-15T07:00:00Z');
    expect(t.due).toBe('2026-09-30');
    expect(t.comments[0].createdAt).toBe('2026-09-16T02:00:00Z');
    const sub = issue(p, 'ORB-14');
    expect(sub.resolved).toBe('2026-09-18');
    expect(sub.resolvedAt).toBe('2026-09-18T10:45:00Z');
  });

  it('uses 父项关键字 for subtasks and recognises 长篇故事 as an epic', () => {
    expect(issue(p, 'ORB-10').kind).toBe('epic');
    expect(issue(p, 'ORB-14').kind).toBe('subtask');
    expect(issue(p, 'ORB-14').parentKey).toBe('ORB-11');
    expect(issue(p, 'ORB-11').parentKey).toBeNull();
    expect(p.hierarchy).toEqual({ linked: 1, epicChildren: 1, unlinked: 0 });
  });

  it('counts commenters that appear only as an account id', () => {
    expect(p.unresolvedCommenters).toBe(1);
    expect(issue(p, 'ORB-11').comments[2].authorKey).toBeNull();
  });

  it('reads the 附件 column', () => {
    expect(issue(p, 'ORB-11').attachments).toEqual([
      { id: '40001', fileName: '列表截图.png', uploadedAt: '2026-09-15T07:10:00Z', uploaderAccountId: '6a00000000000000000b0002' },
    ]);
  });
});

describe('Traditional Chinese team (Simplified headers, Traditional values)', () => {
  const p = parseOk(twCsv);

  it('maps Traditional Chinese statuses, priorities and issue types', () => {
    expect(issue(p, 'KITE-1').statusId).toBe('s2'); // 進行中
    expect(issue(p, 'KITE-2').statusId).toBe('s1'); // 待辦
    expect(issue(p, 'KITE-3').statusId).toBe('s6'); // 完成
    expect(issue(p, 'KITE-4').statusId).toBe('s7'); // 不做了
    expect(issue(p, 'KITE-1').priority).toBe('highest');
    expect(issue(p, 'KITE-3').priority).toBe('medium');
    expect(issue(p, 'KITE-1').kind).toBe('epic'); // 大型工作
    expect(issue(p, 'KITE-3').kind).toBe('subtask'); // 子任務
    expect(issue(p, 'KITE-2').due).toBe('2026-03-20'); // 20/3月/26
  });

  it('treats spelling variants of a name as one person', () => {
    expect(p.people.map((x) => x.name)).toEqual(['柯雨辰', '溫子晴', 'Kai Lin', '范一帆']);
    expect(issue(p, 'KITE-3').assigneeKey).toBe(personKey('柯雨辰'));
    expect(issue(p, 'KITE-4').assigneeKey).toBe(personKey('溫子晴'));
    expect(issue(p, 'KITE-4').reporterKey).toBe(personKey('Kai Lin'));
  });

  it('links the subtask but not the children of the epic', () => {
    expect(issue(p, 'KITE-3').parentKey).toBe('KITE-2');
    expect(issue(p, 'KITE-2').parentKey).toBeNull();
    expect(p.hierarchy).toEqual({ linked: 1, epicChildren: 1, unlinked: 0 });
  });

  it('derives the project key from the issue key when the column is missing', () => {
    const res = parseOk('摘要,事务密钥\n一張卡,KITE-9\n');
    expect(res.issues[0].projectKey).toBe('KITE');
  });
});

describe('statuses of the target workspace', () => {
  // worker/seed.sql defaults; `p` is the cloud tenant prefix
  const defaults = (p = ''): WorkspaceStatus[] => [
    { id: `${p}s1`, name: '待辦', sort_order: 1, is_done: 0, auto_start: 0 },
    { id: `${p}s2`, name: '正在進行', sort_order: 2, is_done: 0, auto_start: 1 },
    { id: `${p}s3`, name: '待驗收', sort_order: 3, is_done: 0, auto_start: 0 },
    { id: `${p}s4`, name: '待討論確認', sort_order: 4, is_done: 0, auto_start: 0 },
    { id: `${p}s5`, name: '等待部署', sort_order: 5, is_done: 0, auto_start: 0 },
    { id: `${p}s6`, name: '完成', sort_order: 6, is_done: 1, auto_start: 0 },
    { id: `${p}s7`, name: '不做了', sort_order: 7, is_done: 1, auto_start: 0 },
  ];
  const issues = (...pairs: [string, string][]) =>
    pairs.map(([status, statusCategory], i) => ({ key: `NOVA-${i + 1}`, status, statusCategory }));
  const resolve = (statuses: WorkspaceStatus[], pairs: [string, string][], idPrefix = '') => {
    const plan = planStatuses(issues(...pairs), statuses, { idPrefix });
    if (plan.ok !== true) throw new Error('expected a plan');
    return { plan, ids: pairs.map((_, i) => plan.statusIdOf(`NOVA-${i + 1}`)) };
  };

  it('compares names across case, width and Traditional / Simplified', () => {
    expect(statusNameKey('待验收')).toBe(statusNameKey('待驗收'));
    expect(statusNameKey('等待部屬')).toBe(statusNameKey('等待部署'));
    expect(statusNameKey(' ＩＮ  Review ')).toBe(statusNameKey('in review'));
  });

  it('maps onto the default statuses, by name first', () => {
    const { plan, ids } = resolve(defaults('ab12cd34-'), [
      ['待办', '待办'], ['正在进行', '正在进行'], ['待验收', '待办'], ['等待部屬', '正在进行'],
      ['不做了', '待办'], ['Done', 'Done'], ['Blocked', 'In Progress'], ['', ''],
    ], 'ab12cd34-');
    expect(ids).toEqual(['s1', 's2', 's3', 's5', 's7', 's6', 's2', 's1'].map((id) => `ab12cd34-${id}`));
    expect(plan.isDone('ab12cd34-s7')).toBe(true);
    expect(plan.isDone('ab12cd34-s3')).toBe(false);
    const byJira = Object.fromEntries(plan.mapping.map((r) => [r.jiraStatus, r]));
    expect(byJira['待验收']).toMatchObject({ statusName: '待驗收', via: 'name', substituted: false, issueCount: 1 });
    expect(byJira['Done']).toMatchObject({ statusName: '完成', via: 'alias' });
    expect(byJira['Blocked']).toMatchObject({ statusName: '正在進行', via: 'category' });
    expect(byJira['']).toMatchObject({ statusName: '待辦', via: 'default' });
  });

  it('uses a customised workspace: renamed and added statuses', () => {
    const statuses = defaults().map((st) =>
      st.id === 's3' ? { ...st, name: 'Code Review' } : st.id === 's6' ? { ...st, name: 'Shipped' } : st,
    );
    statuses.push({ id: 'qa-1', name: '待驗收', sort_order: 8, is_done: 0 }); // a new status carries the old name
    const { ids } = resolve(statuses, [['待驗收', '待办'], ['Done', 'Done'], ['Code Review', 'In Progress']]);
    expect(ids).toEqual(['qa-1', 's6', 's3']);
  });

  it('stands in for a deleted default status and never returns a missing id', () => {
    const statuses = defaults().filter((st) => st.id !== 's7' && st.id !== 's1');
    const { plan, ids } = resolve(statuses, [['不做了', '待办'], ["Won't Do", 'Done'], ['待办', '待办'], ['Open', 'To Do']]);
    expect(ids).toEqual(['s6', 's6', 's3', 's3']); // done → first done; to-do → first open non-auto-start column
    const known = new Set(statuses.map((st) => st.id));
    expect(plan.mapping.every((r) => known.has(r.statusId))).toBe(true);
    expect(plan.mapping.find((r) => r.jiraStatus === '不做了')).toMatchObject({ statusName: '完成', via: 'alias', substituted: true });
  });

  it('does not use a default id whose meaning changed', () => {
    const statuses = defaults().map((st) => (st.id === 's2' ? { ...st, name: '封存', is_done: 1, auto_start: 0 } : st));
    const { ids } = resolve(statuses, [['In Progress', 'In Progress']]);
    expect(ids).toEqual(['s3']); // s2 is a done status now: the next open column takes in-progress work
  });

  it('refuses a workspace without statuses', () => {
    expect(planStatuses(issues(['To Do', 'To Do']), [])).toEqual({ ok: false, error: 'no_statuses' });
  });

  it('keeps the raw Jira status on parsed issues', () => {
    const res = parseOk('Summary,Issue key,Status,Status Category\nA,NOVA-1, In  Review ,In Progress\n');
    expect(res.issues[0]).toMatchObject({ status: 'In Review', statusCategory: 'In Progress', statusId: 's2' });
  });
});
