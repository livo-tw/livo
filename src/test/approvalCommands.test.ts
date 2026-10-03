import {describe,it,expect,vi} from 'vitest';
import {parseApprovalCommand,canonicalApprovalPayload,approvalSnapshotSteps,canActOnApproval} from '@/lib/approval/core';
import {createApprovalCommandRunner,executeApprovalCommand} from '@/lib/approvalCommands';
import type {ApprovalCommand,ApprovalCommandResult,ApprovalStepSnapshot,ApprovalRequestState} from '@/lib/approval/core';
const submit:Extract<ApprovalCommand,{operation:'submit'}>={commandId:'command-0001',operation:'submit',taskId:'task-1',expected:{statusId:'todo',requiresApproval:false,currentApprovalId:null,approvalStatus:null},toStatusId:'done',expectedRuleId:null,enableRequirement:true};
const step:ApprovalStepSnapshot={step_order:1,approver_type:'role' as const,approver_role:'admin',approver_user_id:null};
const request:ApprovalRequestState={id:'request-1',task_id:'task-1',rule_id:null,requested_by:'member-1',from_status:'todo',to_status:'done',current_step:1,status:'pending' as const,version:1,steps_snapshot:[step],created_at:'2026-01-01T00:00:00Z',completed_at:null};
const task={id:'task-1',status_id:'todo',requires_approval:true,approval_status:'pending_approval',current_approval_id:'request-1'};
const result=(commandId:string):ApprovalCommandResult=>({commandId,replayed:false,eventId:'event-1',request,task});
const dbWith=(invoke:ReturnType<typeof vi.fn>)=>({functions:{invoke}}) as unknown as Parameters<typeof executeApprovalCommand>[0];
describe('approval strict wire contract',()=>{
 it('normalizes valid submit without authority fields',()=>expect(parseApprovalCommand(submit)).toEqual(submit));
 it.each(['actorId','actorRole','workspaceId','afterState','approvers'])('rejects client supplied %s',field=>expect(()=>parseApprovalCommand({...submit,[field]:'forged'})).toThrow('approval_invalid_input'));
 it('rejects nested extras, missing expectations and coercion',()=>{
  for(const expected of [{...submit.expected,role:'admin'},{statusId:'todo'},{...submit.expected,requiresApproval:1}])
   expect(()=>parseApprovalCommand({...submit,expected})).toThrow();
 });
 it('requires positive safe integer versions/steps',()=>{
  for(const expectedVersion of [0,-1,1.5,'1',NaN,Infinity,Number.MAX_SAFE_INTEGER+1])
   expect(()=>parseApprovalCommand({commandId:'command-0001',operation:'approve',requestId:'r',expectedStep:1,expectedVersion})).toThrow();
 });
 it('canonicalizes key order and absent/blank comments equally',()=>{
  const first={operation:'approve',requestId:'r',expectedVersion:1,expectedStep:1,commandId:'command-0001'};
  const second={commandId:'command-0001',expectedStep:1,expectedVersion:1,requestId:'r',operation:'approve',comment:'  '};
  expect(canonicalApprovalPayload(first)).toBe(canonicalApprovalPayload(second));
 });
 it('enforces comments by Unicode characters, blocks NUL and invalid identifiers',()=>{
  const command={commandId:'command-0001',operation:'return',requestId:'r',expectedVersion:1,expectedStep:1};
  expect(()=>parseApprovalCommand({...command,comment:'😀'.repeat(4000)})).not.toThrow();
  expect(()=>parseApprovalCommand({...command,comment:'😀'.repeat(4001)})).toThrow();
  expect(()=>parseApprovalCommand({...command,comment:'a\0b'})).toThrow();
  expect(()=>parseApprovalCommand({...command,requestId:'r\n'})).toThrow();
 });
 it('rejects unknown operations and missing/null/array requests',()=>{
  for(const value of [null,[],{...submit,operation:'delete'},{...submit,commandId:'short'}] as unknown[]) expect(()=>parseApprovalCommand(value)).toThrow();
 });
});
describe('immutable step authorization',()=>{
 it('fails closed for legacy/malformed snapshots',()=>{
  for(const steps_snapshot of [null,[],[{...step,step_order:2}],[{...step,approver_user_id:'other'}]])
   expect(approvalSnapshotSteps({...request,steps_snapshot})).toBeNull();
 });
 it('allows admin+super only for no-rule fallback, exact role on real rule',()=>{
  expect(canActOnApproval(request,{id:'a',role:'super_admin'})).toBe(true);
  expect(canActOnApproval({...request,rule_id:'rule-1'},{id:'a',role:'super_admin'})).toBe(false);
  expect(canActOnApproval({...request,rule_id:'rule-1'},{id:'a',role:'admin'})).toBe(true);
  expect(canActOnApproval(request,{id:'a',role:'admin',active:false})).toBe(false);
 });
 it('does not grant an administrator another user step or a completed request',()=>{
  const r:ApprovalRequestState={...request,rule_id:'rule-1',steps_snapshot:[{...step,approver_type:'user' as const,approver_role:null,approver_user_id:'owner'}]};
  expect(canActOnApproval(r,{id:'admin',role:'admin'})).toBe(false);
  expect(canActOnApproval(r,{id:'owner',role:'member'})).toBe(true);
  expect(canActOnApproval({...r,status:'approved'},{id:'owner',role:'member'})).toBe(false);
 });
});
describe('approval delivery client',()=>{
 it('retries uncertain transport using the exact same intent ID',async()=>{
  const invoke=vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementation(async(_name,{body})=>({data:result(body.commandId),error:null}));
  const saved=await executeApprovalCommand(dbWith(invoke),parseApprovalCommand(submit));
  expect(saved.request?.id).toBe('request-1');
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls[0][1]).toEqual(invoke.mock.calls[1][1]);
 });
 it('retains uncertain intent across user retries and never sends actor metadata',async()=>{
  const invoke=vi.fn().mockRejectedValue(new Error('network')), run=createApprovalCommandRunner(dbWith(invoke));
  const {commandId:_id,...intent}=parseApprovalCommand(submit);
  await expect(run(intent)).rejects.toThrow('approval_transport_error');
  const first=invoke.mock.calls[0][1].body as ApprovalCommand;
  invoke.mockImplementation(async(_name,{body})=>({data:result(body.commandId),error:null}));
  await run(intent);
  expect(invoke.mock.calls[2][1].body.commandId).toBe(first.commandId);
  expect(invoke.mock.calls[2][1].body).not.toHaveProperty('actorId');
 });
 it('never retries a definitive permission or conflict response',async()=>{
  const invoke=vi.fn(async()=>({data:{error:'approval_forbidden'},error:null}));
  await expect(executeApprovalCommand(dbWith(invoke),parseApprovalCommand(submit))).rejects.toThrow('approval_forbidden');
  expect(invoke).toHaveBeenCalledOnce();
 });
 it('shares concurrent clicks and rejects a mismatched receipt',async()=>{
  let resolve:(value:unknown)=>void=()=>{};
  const invoke=vi.fn<(_name:string,options:{body:ApprovalCommand})=>Promise<unknown>>(()=>new Promise(r=>{resolve=r;})),run=createApprovalCommandRunner(dbWith(invoke));
  const {commandId:_id,...intent}=parseApprovalCommand(submit);
  const a=run(intent),b=run(intent);expect(a).toBe(b);
  resolve({data:result(invoke.mock.calls[0][1].body.commandId),error:null});await a;
  const bad=vi.fn(async()=>({data:result('wrong-command'),error:null}));
  await expect(executeApprovalCommand(dbWith(bad),parseApprovalCommand(submit))).rejects.toThrow('approval_transport_error');
 });

  it('treats a backend unavailable response as an uncertain commit and preserves the ID',async()=>{
    const invoke=vi.fn<(_name:string,options:{body:ApprovalCommand})=>Promise<{data:unknown;error:unknown}>>(async()=>({data:{error:'approval_unavailable'},error:null}));
    const run=createApprovalCommandRunner(dbWith(invoke));
    const {commandId:_id,...intent}=parseApprovalCommand(submit);
    await expect(run(intent)).rejects.toThrow('approval_transport_error');
    const commandId=invoke.mock.calls[0][1].body.commandId;
    invoke.mockImplementation(async(_name,{body})=>({data:result(body.commandId),error:null}));
    await run(intent);
    expect(invoke.mock.calls[2][1].body.commandId).toBe(commandId);
  });

});
