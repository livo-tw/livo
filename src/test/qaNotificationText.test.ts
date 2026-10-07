// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { qaDueDateText, qaFieldChanges, qaFieldNotificationText, qaNotificationDetailText, qaNotificationReferences, qaPriorityText } from '../lib/qa/notificationText';
import { qaNotificationMessage, type QaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-core';
import { loadQaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-backend';
import type { Database } from '../../docker/volumes/functions/slack-interact/backend';
import type { Job } from '../../docker/volumes/functions/slack-deliver/core';
import type { QaIssue } from '../lib/qa/domain';

type Snapshot = { projectId: string; assigneeId: string | null; qaOwnerId: string | null; severity: string; priority: number; dueDate: string | null };
const before: Snapshot = { projectId: 'old-project', assigneeId: 'old-developer', qaOwnerId: 'old-qa', severity: 'high', priority: 1, dueDate: null };
const after: Snapshot = { projectId: 'new-project', assigneeId: 'new-developer', qaOwnerId: null, severity: 'low', priority: 5, dueDate: '2026-10-20' };
const detail = JSON.stringify({ before, after });
const members: Record<string, string> = { 'old-developer': 'Alex', 'new-developer': 'Blair', 'old-qa': 'Casey' };
const projects: Record<string, string> = { 'old-project': 'Atlas', 'new-project': 'Boreal' };
const ctx = { memberName: (id: string) => members[id], projectName: (id: string) => projects[id] };
const state: QaDeliveryState = {
  issue: { id: 'private-issue-identifier', projectId: 'new-project', title: 'Example bug', state: 'triaged', assigneeId: 'new-developer', qaOwnerId: null,
    severity: 'low', priority: 5, dueDate: '2026-10-20', targets: [], runs: [], fixCycle: 0 } as unknown as QaIssue,
  project: { id: 'new-project', name: 'Boreal', is_archived: false }, members: [{ id: 'new-developer', name: 'Blair' }],
  triagers: ['new-developer'], memberNames: members, projectNames: projects,
};
const job: Job = { id: 1, task_id: 'qa:private-issue-identifier', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
  payload: { eventType: 'update_fields', actorId: 'new-developer', issueId: state.issue.id, detail } };

describe('human-readable QA notices from immutable audit snapshots', () => {
  it.each([[1, '最高'], [2, '高'], [3, '中'], [4, '低'], [5, '最低']] as const)('labels stored priority %s correctly', (priority, label) => {
    expect(qaPriorityText(priority)).toBe(label); expect(qaPriorityText(String(priority))).toBe(label);
  });
  it('uses the same priority meanings in English and simplified Chinese', () => {
    expect(qaPriorityText(1, 'en-US')).toBe('Highest'); expect(qaPriorityText(5, 'en')).toBe('Lowest'); expect(qaPriorityText(4, 'zh_CN')).toBe('低');
  });
  it.each([0, 6, 2.5, 'P4', null, {}, 'private-code'])('never prints an unknown priority code %s', value => {
    expect(qaPriorityText(value)).toBe('未設定');
  });
  it('renders all six changed fields, names, priorities and dates without raw snapshots or internal ids', () => {
    const text = qaFieldNotificationText(detail, ctx);
    expect(text.split('\n')).toEqual(['專案：Atlas → Boreal', '修復負責人：Alex → Blair', '驗證 QA：Casey → 未指定', '嚴重程度：高 → 低', '優先級：最高 → 最低', '期限：未設定 → 2026-10-20']);
    for (const id of [...Object.keys(members), ...Object.keys(projects)]) expect(text).not.toContain(id);
    expect(text).not.toContain('before'); expect(text).not.toContain('after'); expect(text).not.toContain('{');
    expect(JSON.parse(detail)).toEqual({ before, after });
  });
  it('omits unchanged fields and supports snapshots without a before value', () => {
    expect(qaFieldNotificationText(JSON.stringify({ before, after: { ...before, priority: 4 } }), ctx)).toBe('優先級：最高 → 低');
    expect(qaFieldNotificationText(JSON.stringify({ after: { priority: 4, assigneeId: null } }), ctx)).toBe('修復負責人：未指定\n優先級：低');
  });
  it.each(['not-json private-id', JSON.stringify({ after: [] }), JSON.stringify({ before: [], after }), 'x'.repeat(16001)])('fails closed on malformed snapshots', value => {
    expect(qaFieldChanges(value)).toBeNull(); expect(qaFieldNotificationText(value, ctx)).toBe('Bug 欄位已更新，請在 LIVO 查看詳情。');
  });
  it('redacts missing, stale and invalid label ids instead of calling them unassigned', () => {
    const value = JSON.stringify({ after: { projectId: 'missing-project', assigneeId: 'missing-member', qaOwnerId: { id: 'nested-secret' }, unknownField: 'hidden-id' } });
    const text = qaFieldNotificationText(value, ctx);
    expect(text).toBe('專案：未知專案\n修復負責人：未知成員\n驗證 QA：未知成員');
    expect(text).not.toContain('missing-'); expect(text).not.toContain('nested-secret'); expect(text).not.toContain('hidden-id');
    expect(qaFieldNotificationText(JSON.stringify({ after: { assigneeId: 'same-id' } }), { ...ctx, memberName: id => id })).toContain('未知成員');
  });
  it('preserves real date-only values and redacts invalid date input', () => {
    expect(qaDueDateText('2026-10-20')).toBe('2026-10-20'); expect(qaDueDateText('2026-02-30')).toBe('未設定');
    expect(qaDueDateText('2026-10-20T00:00:00Z')).toBe('未設定'); expect(qaDueDateText('private-date-code')).toBe('未設定');
  });
  it('looks up only bounded known ids from fields that changed', () => {
    expect(qaNotificationReferences('update_fields', detail)).toEqual({ members: ['old-developer', 'new-developer', 'old-qa'], projects: ['old-project', 'new-project'] });
    expect(qaNotificationReferences('comment', detail)).toEqual({ members: [], projects: [] });
    expect(qaNotificationReferences('update_fields', JSON.stringify({ after: { assigneeId: 'x),or(id.eq.other)', projectId: 'bad,project' } }))).toEqual({ members: [], projects: [] });
  });
  it('translates existing triage audit codes and names without rewriting the snapshot', () => {
    const text = qaNotificationDetailText('triage', 'RD: new-developer · QA: old-qa\nlow · P4\n2026-10-20', ctx);
    expect(text).toContain('修復負責人：Blair'); expect(text).toContain('驗證 QA：Casey'); expect(text).toContain('優先級：低');
    expect(text).not.toContain('P4'); expect(text).not.toContain('new-developer');
    expect(qaNotificationDetailText('comment', 'Hello', ctx)).toBeUndefined();
  });
  it.each(['channel', 'member'] as const)('uses readable escaped field changes in %s Slack notices', target_type => {
    const message = qaNotificationMessage({ ...state, memberNames: { ...members, 'new-developer': 'Blair <!channel>' } }, { ...job, target_type }, 'https://example.com');
    expect(message.text).toContain('修復負責人：Alex → Blair &lt;!channel&gt;'); expect(message.text).toContain('專案：Atlas → Boreal');
    expect(message.text).toContain('優先級：最低'); expect(message.text).not.toContain('P5'); expect(message.text).not.toContain('"before"');
    const visible = message.blocks.map((block: { text?: { text: string } }) => block.text?.text || '').join('\n').replace(/<[^|]+\|([^>]+)>/g, '$1');
    expect(visible).not.toContain(state.issue.id); expect(visible).not.toContain('old-developer');
    expect(message.blocks.filter((block: { type: string }) => block.type === 'header')).toHaveLength(0);
  });
  it('keeps unresolved summary names safe even for inherited object property names', () => {
    const message = qaNotificationMessage({ ...state, issue: { ...state.issue, assigneeId: 'constructor' } }, { ...job, payload: { ...job.payload, actorId: 'toString' } }, 'https://example.com');
    expect(message.text).toContain('修復：未知成員'); expect(message.text).toContain('操作人：未知成員'); expect(message.text).not.toContain('function');
  });
  it('loads inactive member and archived project labels without changing responsible recipients', async () => {
    const rows = vi.fn(async (table: string, query: Record<string, string>) => {
      if (table === 'qa_issues') return [{ data: state.issue }];
      if (table === 'qa_project_coordination') return [{ coordinator_id: 'new-developer' }];
      if (table === 'projects') return query.id.startsWith('in.') ? [{ id: 'old-project', name: 'Atlas' }, state.project] : [state.project];
      if (table === 'members') return query.id ? [{ id: 'old-developer', name: 'Alex', role: 'super_admin', is_active: false }, { id: 'old-qa', name: 'Casey' }, { id: 'new-developer', name: 'Blair' }] : state.members;
      throw new Error('unexpected lookup');
    });
    const loaded = await loadQaDeliveryState({ rows } as unknown as Database, state.issue.id, 'update_fields', detail);
    expect(loaded?.memberNames?.['old-developer']).toBe('Alex'); expect(loaded?.projectNames?.['old-project']).toBe('Atlas');
    expect(loaded?.triagers).toEqual(['new-developer']); expect(loaded?.members).toEqual(state.members);
    for (const [table, query] of rows.mock.calls) if (['members', 'projects'].includes(table) && query.id?.startsWith('in.')) {
      expect(query).toMatchObject({ select: 'id,name', limit: '10' }); expect(query).not.toHaveProperty('workspace_id'); expect(query).not.toHaveProperty('is_active');
    }
  });
});
