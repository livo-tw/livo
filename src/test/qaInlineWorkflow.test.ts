import { describe, expect, it } from 'vitest';
import { applyQaCommand, canQaCommand, createQaIssue, qaEventDetail, type QaContext, type QaIssue, type QaCommand } from '../lib/qa/domain';
import { validateQaBackup } from '../../docker/volumes/functions/qa/restore';

let serial = 0;
const ctx = (actor = 'reporter'): QaContext => ({
  actor: { id: actor, role: 'member' }, workspaceId: 'workspace-a', now: '2026-10-06T00:00:00.000Z',
  newId: () => `example-${++serial}`, memberIds: new Set(['reporter', 'developer', 'tester', 'observer']),
  projectIds: new Set(['project-a', 'project-b']), taskIds: new Set(), duplicateIssueIds: new Set(),
  environmentValues: ['Staging', 'Live Staging', 'Production'],
});
const report = () => createQaIssue({ projectId: 'project-a', title: 'Example rendering issue', actual: 'Example content wraps incorrectly', observedEnvironment: 'Staging' }, 'example-issue', ctx());
const fields = (issue: QaIssue, patch: Partial<Extract<QaCommand, { type: 'update_fields' }>> = {}): Extract<QaCommand, { type: 'update_fields' }> => ({
  type: 'update_fields', projectId: issue.projectId, assigneeId: issue.assigneeId, qaOwnerId: issue.qaOwnerId,
  severity: issue.severity, priority: issue.priority, dueDate: issue.dueDate, ...patch,
});
const assigned = () => { const issue = report(); return applyQaCommand(issue, fields(issue, { assigneeId: 'developer', qaOwnerId: 'tester' }), ctx()); };
const repaired = () => applyQaCommand(assigned(), { type: 'submit_fix', summary: '', targets: [{ environment: 'Staging', component: '', build: '', required: true }] }, ctx('developer'));
const deployed = () => { const issue = repaired(); return applyQaCommand(issue, { type: 'record_deployment', targetId: issue.targets[0].id, build: '', evidence: '' }, ctx('developer')); };
const verified = () => { const issue = deployed(); return applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[0].id, build: '', result: 'pass', note: '' }, ctx('tester')); };

describe('QA direct fields and optional workflow details', () => {
  it('assigns either role independently without acknowledging or advancing the workflow', () => {
    const original = report(); const next = applyQaCommand(original, fields(original, { qaOwnerId: 'tester' }), ctx('observer'));
    expect(next).toMatchObject({ state: 'new', assigneeId: null, qaOwnerId: 'tester', version: original.version + 1, fixCycle: 0, targets: [], runs: [] });
    expect(qaEventDetail(next, 'update_fields', original)).toContain('"before"');
    expect(original.qaOwnerId).toBe('reporter');
  });
  it('starts work after direct assignment without asking the developer to repeat triage', () => {
    expect(canQaCommand(assigned(), ctx('developer').actor, 'start_fix')).toBe(true);
    expect(applyQaCommand(assigned(), { type: 'start_fix' }, ctx('developer')).state).toBe('in_progress');
    expect(canQaCommand(report(), ctx('developer').actor, 'start_fix')).toBe(false);
    expect(canQaCommand(assigned(), ctx('observer').actor, 'submit_fix')).toBe(false);
  });
  it('preserves all real evidence and closed state when changing completed metadata', () => {
    const closed = verified();
    expect(closed).toMatchObject({state:'closed',resolution:'fixed',closedAt:ctx().now,closedBy:'tester'});
    const next = applyQaCommand(closed, fields(closed, { projectId: 'project-b', assigneeId: null, qaOwnerId: null, priority: 2 }), ctx('observer'));
    const omit = ({ projectId, assigneeId, qaOwnerId, priority, version, updatedAt, ...rest }: QaIssue) => rest;
    expect(omit(next)).toEqual(omit(closed));
    expect(next.state).toBe('closed'); expect(canQaCommand(next, ctx('developer').actor, 'submit_fix')).toBe(false);
  });
  it('rejects foreign workspace, unavailable people, unavailable projects and invalid dates', () => {
    const issue = assigned();
    expect(() => applyQaCommand(issue, fields(issue), { ...ctx(), workspaceId: 'workspace-b' })).toThrow('qa_forbidden');
    expect(() => applyQaCommand(issue, fields(issue, { assigneeId: 'inactive-member' }), ctx())).toThrow('qa_member_unavailable');
    expect(() => applyQaCommand(issue, fields(issue, { projectId: 'foreign-project' }), ctx())).toThrow('qa_project_unavailable');
    expect(() => applyQaCommand(issue, fields(issue, { dueDate: '2026-02-31' }), ctx())).toThrow('qa_invalid_date');
  });
  it('does not silently move linked tasks or duplicates across projects', () => {
    const issue = { ...assigned(), taskIds: ['example-task'] };
    expect(() => applyQaCommand(issue, fields(issue, { projectId: 'project-b' }), ctx())).toThrow('qa_task_unavailable');
    const duplicate = { ...assigned(), duplicateOfId: 'example-duplicate' };
    expect(() => applyQaCommand(duplicate, fields(duplicate, { projectId: 'project-b' }), ctx())).toThrow('qa_duplicate_unavailable');
  });
  it('cannot smuggle workflow or evidence into a metadata command', () => {
    const issue = assigned();
    expect(() => applyQaCommand(issue, { ...fields(issue), state: 'closed' } as QaCommand, ctx())).toThrow('qa_invalid_request');
  });
  it('stores genuinely empty optional details but still requires deployment and verification', () => {
    const issue = repaired();
    expect(issue).toMatchObject({ state: 'verification', fixSummary: '', targets: [{ environment: 'Staging', build: '', deploymentEvidence: '', deployedAt: null }] });
    expect(() => applyQaCommand(issue, { type: 'close', resolution: 'fixed', reason: '' }, ctx('tester'))).toThrow('qa_verification_required');
    expect(() => applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[0].id, build: '', result: 'pass', note: '' }, ctx('tester'))).toThrow('qa_not_deployed');
    expect(deployed().targets[0]).toMatchObject({ deployedBy: 'developer', deployedAt: ctx().now, deploymentEvidence: '' });
    expect(verified()).toMatchObject({state:'closed',resolution:'fixed',closedBy:'tester',closedAt:ctx().now,runs:[{result:'pass',note:'',build:''}]});
  });
  it('accepts empty failed-result notes without passing the bug or accepting a mismatched build', () => {
    const issue = deployed();
    const failed = applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[0].id, build: '', result: 'fail', note: '' }, ctx('tester'));
    expect(failed).toMatchObject({ state: 'failed', runs: [{ result: 'fail', note: '' }] });
    expect(() => applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[0].id, build: 'another-build', result: 'pass', note: '' }, ctx('tester'))).toThrow('qa_build_mismatch');
  });
  it('round-trips genuine empty target and verification versions through the backup validator', () => {
    const issue = { ...verified(), workspaceId: 'default' };
    const tables: Record<string, unknown[]> = { qa_issues: [{ id: issue.id, workspace_id: issue.workspaceId, project_id: issue.projectId, state: issue.state, assignee_id: issue.assigneeId, qa_owner_id: issue.qaOwnerId, reporter_id: issue.reporterId, title: issue.title, version: issue.version, updated_at: issue.updatedAt, data: issue }], qa_commands: [], qa_events: [], qa_comments: [], qa_uploads: [], qa_attachments: [], qa_slack_links: [], qa_project_coordination: [], qa_coordination_commands: [] };
    expect(validateQaBackup(tables).qa_issues[0].data.targets[0].build).toBe('');
  });
});
