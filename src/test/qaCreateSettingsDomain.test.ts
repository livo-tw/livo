import { describe, expect, it } from 'vitest';
import { createQaIssue, qaNotificationRecipients, type QaContext, type QaCreateInput } from '../lib/qa/domain';
const input: QaCreateInput = { projectId: 'example-project', title: 'Example rendering issue', actual: 'Unexpected result', observedEnvironment: 'Stage' };
const context: QaContext = { actor: { id: 'reporter', role: 'member', qaCoordinatorProjectIds: ['example-project'] }, workspaceId: 'example-workspace', now: '2026-10-07T00:00:00Z', newId: () => 'example-event', memberIds: new Set(['reporter', 'developer', 'tester']), projectIds: new Set(['example-project']), taskIds: new Set() };
describe('QA create basic settings', () => {
  it('defaults QA ownership to the trusted reporter independently from project coordination', () => {
    expect(createQaIssue(input, 'example-bug', context)).toMatchObject({ reporterId: 'reporter', qaOwnerId: 'reporter', assigneeId: null, priority: 3, dueDate: null, state: 'new', version: 1, targets: [], runs: [], fixCycle: 0 });
  });
  it('preserves selected owners, priority and due date without simulating a workflow action', () => {
    expect(createQaIssue({ ...input, assigneeId: 'developer', qaOwnerId: 'tester', severity: 'high', priority: 2, dueDate: '2026-11-09' }, 'example-bug', context)).toMatchObject({ reporterId: 'reporter', assigneeId: 'developer', qaOwnerId: 'tester', severity: 'high', priority: 2, dueDate: '2026-11-09', state: 'new', version: 1, targets: [], runs: [] });
  });
  it('informs actual selected owners and trusted triagers once, excluding the creating actor', () => {
    const issue = createQaIssue({ ...input, assigneeId: 'developer', qaOwnerId: 'tester' }, 'example-bug', context);
    expect(qaNotificationRecipients(issue, 'create', 'reporter', ['developer', 'coordinator', 'reporter'])).toEqual(['developer', 'coordinator', 'tester']);
    const own = createQaIssue(input, 'own-bug', context);
    expect(qaNotificationRecipients(own, 'create', 'reporter', [])).toEqual([]);
  });
  it('allows explicitly leaving owners empty and keeps a supplied historical area field', () => {
    expect(createQaIssue({ ...input, assigneeId: null, qaOwnerId: null, component: 'Historical imported area' }, 'example-bug', context)).toMatchObject({ assigneeId: null, qaOwnerId: null, component: 'Historical imported area' });
  });
  it.each(['assigneeId', 'qaOwnerId'] as const)('rejects an unavailable %s before creating a record', field => {
    expect(() => createQaIssue({ ...input, [field]: 'unavailable-member' }, 'example-bug', context)).toThrow('qa_member_unavailable');
  });
  it.each([0, 6, 1.5, '2', null])('rejects malformed priority %s', priority => {
    expect(() => createQaIssue({ ...input, priority } as QaCreateInput, 'example-bug', context)).toThrow('qa_invalid_priority');
  });
  it.each(['2026-02-30', '2026-11-09T00:00:00Z', '', 123])('rejects malformed due date %s', dueDate => {
    expect(() => createQaIssue({ ...input, dueDate } as QaCreateInput, 'example-bug', context)).toThrow('qa_invalid_date');
  });
});
