// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { loadQaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-backend';
import { qaNotificationMessage } from '../../docker/volumes/functions/slack-deliver/qa-core';
import type { Database } from '../../docker/volumes/functions/slack-interact/backend';
import type { Job, Row } from '../../docker/volumes/functions/slack-deliver/core';
import { createQaIssue, type QaIssue } from '../lib/qa/domain';

const issue = createQaIssue({ projectId: 'project-example', title: 'Example bug', actual: 'Example failure',
  observedEnvironment: 'Stage', assigneeId: null }, 'issue-example', {
  actor: { id: 'eqa-reporter', role: 'member' }, workspaceId: 'default', now: '2026-11-09T00:00:00Z', newId: () => 'example-id',
  memberIds: new Set(['eqa-reporter']), projectIds: new Set(['project-example']), taskIds: new Set(),
});
const internal = [{ id: 'member-example', name: 'Example coordinator', role: 'admin', is_active: true }];
const external = [{ id: 'eqa-reporter', name: 'Example external tester', is_active: true },
  { id: 'eqa-history', name: 'Historical <!channel> tester', is_active: false },
  { id: 'eqa-unrelated', name: 'Unrelated tester', is_active: true }];
const created: Job = { id: 1, task_id: 'qa:issue-example', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
  payload: { issueId: issue.id, eventType: 'created', actorId: issue.reporterId, detail: '' } };

function database(current = issue, members: Row[] = internal, accounts: Row[] = external) {
  const rows = vi.fn(async (table: string, query: Record<string, string>) => {
    if (table === 'qa_issues') return [{ data: current }];
    if (table === 'projects') return [{ id: current.projectId, name: 'Example project', is_archived: false }];
    if (table === 'qa_project_coordination') return [{ coordinator_id: 'member-example' }];
    if (table === 'members' || table === 'external_qa_accounts') {
      const source = table === 'members' ? members : accounts;
      if (query.is_active) return source.filter(member => member.is_active === true);
      const ids = query.id.slice(4, -1).split(',');
      return source.filter(member => ids.includes(member.id));
    }
    throw new Error('unexpected lookup');
  });
  return { rows, setting: async (): Promise<undefined> => undefined };
}

describe('external QA notification participant labels', () => {
  it('shows a newly reported external QA owner and actor without inventing a repair assignee', async () => {
    const db = database();
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'created', '', issue.reporterId);
    expect(state).toBeDefined();
    const before = structuredClone(state!.issue);
    expect(before.assigneeId).toBeNull();
    expect(before.qaOwnerId).toBe(before.reporterId);
    const message = qaNotificationMessage(state!, created, 'https://example.com');
    expect(message.text).toContain('操作人：Example external tester');
    expect(message.text).toContain('修復：未指定｜驗證：Example external tester');
    expect(message.text).not.toContain('未知成員');
    expect(message.text).not.toContain('eqa-reporter');
    expect(message.text).toContain('*修復部署與驗證*\n尚未回報修復與部署，完成後由指定 QA 驗證。');
    expect(state!.issue).toEqual(before);
    expect(state!.issue.targets).toEqual([]);
    expect(state!.issue.runs).toEqual([]);
    expect(state!.issue.fixCycle).toBe(0);
    expect(state!.members).toEqual(internal);
    expect(state!.triagers).toEqual(['member-example']);
    expect(state!.memberNames).not.toHaveProperty('eqa-unrelated');
    expect(db.rows).toHaveBeenCalledWith('qa_issues', expect.objectContaining({ workspace_id: 'eq.default' }));
    expect(db.rows).toHaveBeenCalledWith('external_qa_accounts', {
      select: 'id,name', id: 'in.(eqa-reporter)', limit: '20',
    });
  });

  it.each(['verification', 'verified', 'closed', 'dismissed'] as const)('does not suggest a new fix for a %s issue with no targets', async status => {
    const db = database({ ...issue, state: status });
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'set_state', '', 'member-example');
    const message = qaNotificationMessage(state!, { ...created, payload: { ...created.payload, eventType: 'set_state', actorId: 'member-example' } }, 'https://example.com');
    expect(message.text).not.toContain('尚未回報修復與部署');
    expect(state!.issue.targets).toEqual([]);
    expect(state!.issue.runs).toEqual([]);
  });

  it('preserves inactive external owner names in immutable field changes without enabling delivery identities', async () => {
    const detail = JSON.stringify({ before: { qaOwnerId: 'eqa-history' }, after: { qaOwnerId: 'eqa-reporter' } });
    const db = database();
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'update_fields', detail, 'member-example');
    const message = qaNotificationMessage(state!, { ...created, payload: { ...created.payload, eventType: 'update_fields', actorId: 'member-example', detail } }, 'https://example.com');
    expect(message.text).toContain('驗證 QA：Historical &lt;!channel&gt; tester → Example external tester');
    expect(message.text).not.toContain('eqa-history');
    expect(state!.members).toEqual(internal);
    expect(state!.triagers).toEqual(['member-example']);
    const lookup = db.rows.mock.calls.find(([table]) => table === 'external_qa_accounts')![1];
    expect(lookup.id).toBe('in.(eqa-history,eqa-reporter)');
    expect(lookup).not.toHaveProperty('is_active');
    expect(Object.keys(lookup).sort()).toEqual(['id', 'limit', 'select']);
  });

  it('resolves an event actor who is no longer a current owner from the trusted queued actor id', async () => {
    const current = { ...issue, reporterId: 'member-example', qaOwnerId: 'member-example' };
    const db = database(current);
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'comment', 'Example comment', 'eqa-history');
    const message = qaNotificationMessage(state!, { ...created, payload: { ...created.payload, eventType: 'comment', actorId: 'eqa-history', detail: 'Example comment' } }, 'https://example.com');
    expect(message.text).toContain('操作人：Historical &lt;!channel&gt; tester');
    expect(db.rows).toHaveBeenCalledWith('external_qa_accounts', expect.objectContaining({ id: 'in.(eqa-history)' }));
  });

  it('keeps inactive real member labels and never classifies a real member from an eqa-looking id', async () => {
    const current: QaIssue = { ...issue, reporterId: 'member-example', assigneeId: 'eqa-internal', qaOwnerId: null };
    const member = { id: 'eqa-internal', name: 'Historical internal developer', role: 'member', is_active: false };
    const db = database(current, [...internal, member], [{ id: member.id, name: 'Wrong external label', is_active: true }]);
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'created', '', 'member-example');
    const message = qaNotificationMessage(state!, { ...created, payload: { ...created.payload, actorId: 'member-example' } }, 'https://example.com');
    expect(message.text).toContain('修復：Historical internal developer｜驗證：未指定');
    expect(message.text).not.toContain('Wrong external label');
    expect(state!.members).toEqual(internal);
    expect(db.rows.mock.calls.some(([table]) => table === 'external_qa_accounts')).toBe(false);
  });

  it('limits external name requests to valid referenced ids and keeps unresolved identities redacted', async () => {
    const current = { ...issue, reporterId: 'member-example', assigneeId: 'missing-member', qaOwnerId: 'x),or(id.eq.secret)' };
    const db = database(current);
    const state = await loadQaDeliveryState(db as unknown as Database, issue.id, 'created', '', 'member-example');
    const message = qaNotificationMessage(state!, { ...created, payload: { ...created.payload, actorId: 'member-example' } }, 'https://example.com');
    expect(message.text).toContain('修復：未知成員｜驗證：未知成員');
    expect(message.text).not.toContain('missing-member');
    expect(message.text).not.toContain('id.eq.secret');
    expect(db.rows).toHaveBeenCalledWith('external_qa_accounts', { select: 'id,name', id: 'in.(missing-member)', limit: '20' });
  });
});
