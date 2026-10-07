import { describe, expect, it } from 'vitest';
import { applyQaCommand, canQaCommand, createQaIssue, isHistoricalQaPass, latestQaRun, qaEventDetail, type QaCommand, type QaContext, type QaIssue } from '../lib/qa/domain';

let serial = 0;
function context(actor = 'admin', role = 'admin'): QaContext {
  return { actor: { id: actor, role }, workspaceId: 'ws-a', now: '2026-10-02T01:00:00.000Z', newId: () => `id-${++serial}`,
    memberIds: new Set(['admin', 'rd', 'qa', 'reporter', 'other']), projectIds: new Set(['p1']), taskIds: new Set(['task-a', 'task-b']), duplicateIssueIds: new Set(['other-issue']) };
}
const report = () => createQaIssue({ projectId: 'p1', title: 'Wallet mismatch', actual: 'Balance differs', observedEnvironment: 'Stage' }, 'issue-1', context('reporter', 'member'));
const triaged = () => applyQaCommand(report(), { type: 'triage', assigneeId: 'rd', qaOwnerId: 'qa', severity: 'high', priority: 1, dueDate: null }, context());
const candidate = () => applyQaCommand(triaged(), { type: 'submit_fix', summary: 'Fix balance rounding', targets: [
  { environment: 'Stage', component: 'API', build: 'build-A', required: true },
  { environment: 'Prod', component: 'API', build: 'build-A', required: true },
] }, context('rd', 'member'));
function deploy(issue: QaIssue, index = 0) { return applyQaCommand(issue, { type: 'record_deployment', targetId: issue.targets[index].id, build: 'build-A', evidence: 'Deployment 123 confirmed' }, context('rd', 'member')); }
function verify(issue: QaIssue, index = 0, result: 'pass' | 'fail' | 'blocked' = 'pass') { return applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[index].id, build: 'build-A', result, note: result === 'pass' ? '' : 'Balance still differs' }, context('qa', 'member')); }

describe('QA lifecycle and authorization', () => {
  it('retains a human-readable candidate and deployment snapshot after a replacement build', () => {
    const first = deploy(candidate()), snapshot = qaEventDetail(first, 'record_deployment');
    const replacement = applyQaCommand(first, { type: 'submit_fix', summary: 'Second candidate', targets: [{ environment: 'Stage', component: 'API', build: 'build-B', required: true }] }, context('rd', 'member'));
    expect(snapshot).toContain('build-A'); expect(snapshot).toContain('Deployment 123 confirmed');
    expect(qaEventDetail(replacement, 'submit_fix')).toContain('build-B'); expect(first.targets[0].build).toBe('build-A');
  });
  it('creates a report without a fake version or shadow task', () => {
    expect(report()).toMatchObject({ state: 'new', observedVersion: '', fixCycle: 0, version: 1, taskIds: [], assigneeId: null });
  });
  it('lets any active member set or change the owners, the reporter included (team decision)', () => {
    expect(applyQaCommand(report(), { type: 'triage', assigneeId: 'reporter', qaOwnerId: 'reporter', severity: 'high', priority: 1, dueDate: null }, context('reporter', 'member'))).toMatchObject({ state: 'triaged', assigneeId: 'reporter', qaOwnerId: 'reporter' });
    expect(canQaCommand(triaged(), { id: 'someone-else', role: 'member' }, 'triage')).toBe(true);
    expect(() => createQaIssue({ ...report(), projectId: 'p1' } as never, 'id1', context())).toThrow('qa_invalid_request');
  });
  it('allows a designated QA lead without granting workspace admin', () => {
    expect(canQaCommand(triaged(), { id: 'qa', role: 'member' }, 'triage')).toBe(true);
    expect(canQaCommand(candidate(), { id: 'rd', role: 'member' }, 'record_verification')).toBe(false);
  });
  it('rejects inactive/cross-workspace members and foreign task references', () => {
    expect(() => applyQaCommand(triaged(), { type: 'link_tasks', taskIds: ['foreign-task'] }, context())).toThrow('qa_task_unavailable');
    expect(() => applyQaCommand(triaged(), { type: 'start_fix' }, { ...context(), workspaceId: 'ws-b' })).toThrow('qa_forbidden');
    expect(() => createQaIssue({ projectId: 'p1', title: 'a', actual: 'b', observedEnvironment: 'Stage' }, 'i', { ...context(), memberIds: new Set() })).toThrow('qa_forbidden');
  });
  it('requires a real deployment before verification and the exact candidate build', () => {
    expect(() => verify(candidate())).toThrow('qa_not_deployed');
    const issue = deploy(candidate());
    expect(() => applyQaCommand(issue, { type: 'record_verification', targetId: issue.targets[0].id, build: 'old-build', result: 'pass', note: '' }, context('qa', 'member'))).toThrow('qa_build_mismatch');
  });
  it('does not close on Stage PASS when Prod remains pending', () => {
    const issue = verify(deploy(candidate()));
    expect(issue.state).toBe('verification');
    expect(() => applyQaCommand(issue, { type: 'close', resolution: 'fixed', reason: '' }, context('qa', 'member'))).toThrow('qa_verification_required');
  });
  it('requires explicit QA close after every required target passes', () => {
    const issue = verify(deploy(verify(deploy(candidate())), 1), 1);
    expect(issue.state).toBe('verified');
    expect(applyQaCommand(issue, { type: 'close', resolution: 'fixed', reason: '' }, context('qa', 'member')).state).toBe('closed');
  });
  it('retains FAIL history; only the next fix submission increments the cycle', () => {
    const original = deploy(candidate());
    const failed = verify(original, 0, 'fail');
    expect(failed.state).toBe('failed'); expect(failed.fixCycle).toBe(1); expect(original.runs).toHaveLength(0);
    const next = applyQaCommand(failed, { type: 'submit_fix', summary: 'Second fix', targets: [{ environment: 'Stage', component: 'API', build: 'build-A', required: true }] }, context('rd', 'member'));
    expect(next.fixCycle).toBe(2); expect(next.runs).toHaveLength(1); expect(next.targets[0].deployedAt).toBeNull();
    expect(latestQaRun(next, next.targets[0].id)).toBeUndefined();
  });
  it('closes a pre-upgrade verification candidate only when its real current evidence is complete', () => {
    const passed = verify(deploy(verify(deploy(candidate())), 1), 1);
    const legacy: QaIssue = { ...passed, state: 'verification' };
    expect(applyQaCommand(legacy, { type:'close', resolution:'fixed', reason:'' }, context('qa','member')).state).toBe('closed');
    const invalid: QaIssue[] = [
      { ...legacy, runs: legacy.runs.slice(0, 1) },
      { ...legacy, fixCycle: legacy.fixCycle + 1 },
      { ...legacy, runs: legacy.runs.map(run => ({ ...run, build:'older-build' })) },
      { ...legacy, runs: legacy.runs.map(run => ({ ...run, result:'fail' })) },
      { ...legacy, targets: legacy.targets.map(target => ({ ...target, deployedAt:null as string | null })) },
      { ...legacy, state:'verified', runs:[] },
    ];
    for (const issue of invalid) expect(() => applyQaCommand(issue, { type:'close', resolution:'fixed', reason:'' }, context('qa','member'))).toThrow('qa_verification_required');
  });
  it('treats blocked separately and uses server attempt ordering', () => {
    const passed = verify(deploy(candidate()));
    const blocked = verify(passed, 0, 'blocked');
    expect(blocked.state).toBe('verification'); expect(blocked.runs).toHaveLength(2);
    expect(latestQaRun(blocked, blocked.targets[0].id)?.result).toBe('blocked');
  });
  it('requires reasons and a valid other issue for alternative closure', () => {
    expect(() => applyQaCommand(triaged(), { type: 'close', resolution: 'wont_fix', reason: '' }, context())).toThrow('qa_required');
    expect(() => applyQaCommand(triaged(), { type: 'close', resolution: 'duplicate', reason: 'duplicate', duplicateOfId: 'issue-1' }, context())).toThrow('qa_duplicate_unavailable');
    const closed = applyQaCommand(triaged(), { type: 'close', resolution: 'duplicate', reason: 'same cause', duplicateOfId: 'other-issue' }, context());
    expect(closed.resolution).toBe('duplicate'); expect(closed.state).toBe('dismissed');
    expect(applyQaCommand(closed, { type: 'reopen', reason: 'Different cause' }, context('reporter', 'member'))).toMatchObject({ state: 'in_progress', fixCycle: 0, resolution: null });
  });
  it('preserves historical PASS without inventing runs and requires a separate explicit close acknowledgement', () => {
    const historical: QaIssue = { ...report(), qaOwnerId:null, state:'verified', legacySource:{ system:'slack_list', originalStatus:'PASS', recordId:'RecHISTORY123', snapshotSha256:'a'.repeat(64) } };
    expect(isHistoricalQaPass(historical)).toBe(true);
    expect(() => applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'checked'},context())).toThrow('qa_verification_required');
    expect(() => applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'',acknowledgeHistoricalPass:true},context())).toThrow('qa_required');
    expect(() => applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'checked',acknowledgeHistoricalPass:true},context('reporter','member'))).toThrow('qa_forbidden');
    const closed = applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'Reviewed the original PASS evidence',acknowledgeHistoricalPass:true},context());
    expect(closed).toMatchObject({state:'closed',fixCycle:0,targets:[],runs:[],resolutionReason:'Reviewed the original PASS evidence'});
    for (const invalid of [{...historical,fixCycle:1},{...historical,legacySource:undefined},{...historical,legacySource:{...historical.legacySource!,originalStatus:'FAIL'}}])
      expect(() => applyQaCommand(invalid,{type:'close',resolution:'fixed',reason:'checked',acknowledgeHistoricalPass:true},context())).toThrow('qa_historical_pass_unavailable');
  });
  it('keeps real PASS and explicit historical acknowledgement mandatory for the default reporter QA owner', () => {
    const own = report();
    expect(own.qaOwnerId).toBe('reporter');
    const reporter = context('reporter','member');
    expect(canQaCommand(own,reporter.actor,'close')).toBe(true);
    expect(() => applyQaCommand(own,{type:'close',resolution:'fixed',reason:''},reporter)).toThrow('qa_verification_required');
    expect(() => applyQaCommand({...own,state:'verified'},{type:'close',resolution:'fixed',reason:'checked'},reporter)).toThrow('qa_verification_required');
    expect(() => applyQaCommand(own,{type:'close',resolution:'fixed',reason:'checked',acknowledgeHistoricalPass:true},reporter)).toThrow('qa_historical_pass_unavailable');
    const historical: QaIssue = {...own,state:'verified',legacySource:{system:'slack_list',originalStatus:'PASS',recordId:'RecHISTORY456',snapshotSha256:'b'.repeat(64)}};
    expect(() => applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'checked'},reporter)).toThrow('qa_verification_required');
    expect(() => applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'',acknowledgeHistoricalPass:true},reporter)).toThrow('qa_required');
    const closed = applyQaCommand(historical,{type:'close',resolution:'fixed',reason:'Reviewed historical evidence',acknowledgeHistoricalPass:true},reporter);
    expect(closed).toMatchObject({state:'closed',fixCycle:0,targets:[],runs:[],qaOwnerId:'reporter'});
  });
  it('cannot inject historical authority through a report or an edit', () => {
    expect(() => createQaIssue({projectId:'p1',title:'x',actual:'x',observedEnvironment:'Stage',legacySource:{system:'slack_list'}} as never,'one',context())).toThrow('qa_invalid_request');
    expect(() => applyQaCommand(report(),{type:'edit',title:'x',actual:'x',steps:'',expected:'',observedEnvironment:'Stage',observedVersion:'',component:'',legacySource:{system:'slack_list'}} as never,context())).toThrow('qa_invalid_request');
  });
  it('keeps imported assigned records with unknown people but requires real triage before submitting a fix', () => {
    const historical: QaIssue = {...report(),state:'triaged'};
    expect(() => applyQaCommand(historical,{type:'submit_fix',summary:'fix',targets:[{environment:'Stage',component:'',build:'one',required:true}]},context())).toThrow('qa_triage_required');
    expect(applyQaCommand(historical,{type:'triage',assigneeId:'rd',qaOwnerId:'qa',severity:'high',priority:1,dueDate:null},context()).state).toBe('triaged');
  });
  it('a new fix invalidates a previous PASS and only real required-target results restore it', () => {
    const passed = verify(deploy(verify(deploy(candidate())),1),1);
    expect(passed.state).toBe('verified');
    const replacement=applyQaCommand(passed,{type:'submit_fix',summary:'new build',targets:[{environment:'Stage',component:'',build:'B',required:true}]},context('rd','member'));
    expect(replacement.state).toBe('verification');
    expect(() => applyQaCommand(replacement,{type:'close',resolution:'fixed',reason:''},context())).toThrow('qa_verification_required');
    expect(verify(passed,0,'blocked').state).toBe('verification');
    expect(verify(passed,0,'fail').state).toBe('failed');
  });
  it('keeps exact catalog environment identity and replaces the imported unknown priority marker only on triage', () => {
    const custom = applyQaCommand(triaged(),{type:'submit_fix',summary:'fix',targets:[{environment:'Prod',component:'API',build:'one',required:true},{environment:'prod',component:'API',build:'two',required:true}]},{...context(),environmentValues:['Prod','prod']});
    expect(custom.targets.map(target=>target.environment)).toEqual(['Prod','prod']);
    const historical = {...report(),legacySource:{system:'slack_list',originalStatus:'PASS',recordId:'RecHISTORY123',snapshotSha256:'a'.repeat(64),priorityMeaning:'LIVO default 3; source has severity only'}};
    expect(applyQaCommand(historical,{type:'hold',reason:'review'},context()).legacySource?.priorityMeaning).toBe('LIVO default 3; source has severity only');
    expect(applyQaCommand(historical,{type:'triage',assigneeId:'rd',qaOwnerId:'qa',severity:'high',priority:2,dueDate:null},context()).legacySource?.priorityMeaning).toBe('LIVO triage selected priority');
  });
  it('rejects unknown fields, all-optional targets, duplicate targets and invalid dates', () => {
    expect(() => applyQaCommand(triaged(), { type: 'start_fix', state: 'closed' } as QaCommand, context())).toThrow('qa_invalid_request');
    expect(() => applyQaCommand(triaged(), { type: 'submit_fix', summary: 'x', targets: [{ environment: 'Stage', component: '', build: 'A', required: false }] }, context())).toThrow('qa_required_target');
    expect(() => applyQaCommand(triaged(), { type: 'triage', assigneeId: 'rd', qaOwnerId: 'qa', severity: 'high', priority: 1, dueDate: '2026-02-30' }, context())).toThrow('qa_invalid_date');
  });
});
