import { describe, expect, it } from 'vitest';
import { applyQaCommand, canQaCommand, createQaIssue, qaEventDetail, qaNotificationRecipients, QA_STATES,
  type QaCommand, type QaContext, type QaIssue } from '../lib/qa/domain';

const context = (id = 'qa', role = 'member'): QaContext => ({
  actor: { id, role }, workspaceId: 'ws-a', now: '2026-10-03T01:00:00.000Z', newId: () => 'new-evidence-id',
  memberIds: new Set(['reporter', 'developer', 'qa', 'admin', 'super', 'outsider']),
  projectIds: new Set(['project-a']), taskIds: new Set(),
});
function fixture(): QaIssue {
  return { ...createQaIssue({ projectId: 'project-a', title: 'A synthetic issue', actual: 'Unexpected result', observedEnvironment: 'Stage' }, 'issue-a', context('reporter')),
    assigneeId: 'developer', qaOwnerId: 'qa', state: 'verified',
    legacySource: { system: 'slack_list', originalStatus: 'PASS', recordId: 'RecABC123', snapshotSha256: 'a'.repeat(64) } };
}

describe('manual QA status changes', () => {
  it.each([['reporter', 'member'], ['developer', 'member'], ['qa', 'member'], ['admin', 'admin'], ['super', 'super_admin']])(
    'allows the existing participant %s to move between all eight states including terminal states', (id, role) => {
      for (const from of QA_STATES) for (const to of QA_STATES) {
        const issue = { ...fixture(), state: from };
        expect(canQaCommand(issue, context(id, role).actor, 'set_state')).toBe(true);
        const next = applyQaCommand(issue, { type: 'set_state', state: to }, context(id, role));
        expect(next.state).toBe(to);
        expect(next.version).toBe(issue.version + 1);
        expect(next.targets).toEqual(issue.targets);
        expect(next.runs).toEqual(issue.runs);
        expect(next.fixCycle).toBe(issue.fixCycle);
      }
    });

  it('changes historical PASS to FAIL without fabricating any deployment or verification', () => {
    const issue = fixture(), original = structuredClone(issue);
    const next = applyQaCommand(issue, { type: 'set_state', state: 'failed' }, context());
    expect(next).toMatchObject({ state: 'failed', targets: [], runs: [], fixCycle: 0, legacySource: issue.legacySource });
    expect(issue).toEqual(original);
    expect(JSON.parse(qaEventDetail(next, 'set_state', issue))).toEqual({ message: '狀態已變更', mode: 'manual', from: 'verified', to: 'failed' });
  });

  it('preserves real candidate, deployment, verification and repair history byte-for-byte', () => {
    const issue = fixture();
    issue.fixCycle = 2; issue.fixSummary = 'Existing fix';
    issue.targets = [{ id: 'target-a', environment: 'Stage', component: 'API', build: 'build-a', required: true,
      deployedAt: '2026-10-02T00:00:00Z', deployedBy: 'developer', deploymentEvidence: 'Existing release reference' }];
    issue.runs = [{ id: 'run-a', sequence: 1, fixCycle: 2, targetId: 'target-a', environment: 'Stage', component: 'API', build: 'build-a', result: 'pass', note: 'Existing note', testerId: 'qa', createdAt: '2026-10-02T00:01:00Z' }];
    const next = applyQaCommand(issue, { type: 'set_state', state: 'failed' }, context('developer'));
    expect(JSON.stringify([next.targets, next.runs, next.fixCycle, next.fixSummary])).toBe(JSON.stringify([issue.targets, issue.runs, issue.fixCycle, issue.fixSummary]));
  });

  it('records the actual closer and clears obsolete resolution when manually reopening', () => {
    const closed = applyQaCommand(fixture(), { type: 'set_state', state: 'closed' }, context('reporter'));
    expect(closed).toMatchObject({ closedAt: context().now, closedBy: 'reporter', resolution: null, resolutionReason: '', duplicateOfId: null });
    const reopened = applyQaCommand({ ...closed, resolution: 'duplicate', resolutionReason: 'Old resolution', duplicateOfId: 'another-issue' }, { type: 'set_state', state: 'new' }, context('developer'));
    expect(reopened).toMatchObject({ closedAt: null, closedBy: null, reopenedAt: context().now, resolution: null, resolutionReason: '', duplicateOfId: null });
    expect(canQaCommand(closed, context('reporter').actor, 'edit')).toBe(false);
  });

  it('retains an existing closure timestamp and actor when the requested state is unchanged', () => {
    const issue = { ...fixture(), state: 'closed' as const, closedAt: '2026-09-01T00:00:00Z', closedBy: 'qa' };
    expect(applyQaCommand(issue, { type: 'set_state', state: 'closed' }, context('reporter'))).toMatchObject({ closedAt: issue.closedAt, closedBy: 'qa' });
  });

  it('rejects unrelated members, inactive actors and cross-workspace/project calls', () => {
    expect(canQaCommand(fixture(), context('outsider').actor, 'set_state')).toBe(false);
    for (const ctx of [context('outsider'), { ...context(), memberIds: new Set<string>() },
      { ...context(), workspaceId: 'other-workspace' }, { ...context(), projectIds: new Set<string>() }]) {
      expect(() => applyQaCommand(fixture(), { type: 'set_state', state: 'failed' }, ctx)).toThrow('qa_forbidden');
    }
  });

  it('rejects arbitrary states and attempts to smuggle evidence or closing attribution', () => {
    for (const command of [{ type: 'set_state', state: 'invented' }, { type: 'set_state', state: 'failed', runs: [] as QaIssue['runs'] },
      { type: 'set_state', state: 'closed', resolution: 'fixed' }, { type: 'set_state', state: 'closed', closedBy: 'other' }]) {
      expect(() => applyQaCommand(fixture(), command as QaCommand, context())).toThrow();
    }
  });

  it('notifies other participants without sending a duplicate notice to the acting member', () => {
    expect(qaNotificationRecipients(fixture(), 'set_state', 'qa')).toEqual(['reporter', 'developer']);
  });
});
