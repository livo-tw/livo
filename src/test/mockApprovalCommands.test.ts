import {describe,it,expect} from 'vitest';
import {mockApprovalCommand} from '@/integrations/supabase/mockApprovalCommands';
import type {ApprovalCommand} from '@/lib/approval/core';

type Store=Parameters<typeof mockApprovalCommand>[0];
function fixture():Store{return{
 members:[{id:'member-1',auth_id:'auth-1',role:'member',is_active:true},{id:'admin-1',auth_id:'auth-2',role:'admin',is_active:true}],
 system_settings:[{key:'feature_toggles',value:{approvals:true}}],projects:[{id:'project-1',is_archived:false}],
 tasks:[{id:'task-1',project_id:'project-1',status_id:'todo',requires_approval:false,approval_status:null,current_approval_id:null}],
 statuses:[{id:'todo',is_done:false},{id:'done',is_done:true}],approval_rules:[],approval_requests:[],approval_actions:[]};}
const submit:Extract<ApprovalCommand,{operation:'submit'}>={commandId:'submit-0001',operation:'submit',taskId:'task-1',expected:{statusId:'todo',requiresApproval:false,currentApprovalId:null,approvalStatus:null},toStatusId:'done',expectedRuleId:null,enableRequirement:true};
describe('offline approval commands',()=>{
 it('submits and approves atomically with history and a durable receipt',()=>{
  const db=fixture();let id=0;const next=()=>String(++id);
  const r=mockApprovalCommand(db,'auth-1',submit,next);
  expect(r.task.requires_approval).toBe(true);expect(r.request?.steps_snapshot).toHaveLength(1);
  const decision={commandId:'approve-0001',operation:'approve',requestId:r.request!.id,expectedVersion:1,expectedStep:1};
  expect(()=>mockApprovalCommand(db,'auth-1',decision,next)).toThrow('approval_forbidden');
  expect(db.approval_actions).toHaveLength(0);
  const saved=mockApprovalCommand(db,'auth-2',decision,next);
  expect(saved.request).toMatchObject({status:'approved',version:2});expect(saved.task).toMatchObject({status_id:'done',current_approval_id:null,approval_status:null});
  expect(db.status_logs).toHaveLength(1);expect(db.approval_actions).toHaveLength(1);
  expect(mockApprovalCommand(db,'auth-2',decision,next).replayed).toBe(true);
  expect(db.status_logs).toHaveLength(1);expect(db.approval_actions).toHaveLength(1);
 });
 it('rolls back all writes when the final status prerequisite fails',()=>{
  const db=fixture();let id=0;const next=()=>String(++id),r=mockApprovalCommand(db,'auth-1',submit,next);
  db.status_transition_rules=[{target_status_id:'done',required_status_id:'review'}];
  const before=structuredClone(db);
  expect(()=>mockApprovalCommand(db,'auth-2',{commandId:'approve-0002',operation:'approve',requestId:r.request!.id,expectedVersion:1,expectedStep:1},next)).toThrow('approval_transition_prerequisite');
  expect(db).toEqual(before);
 });
 it('keeps legacy requests withdrawable while the feature is OFF',()=>{
  const db=fixture();let id=0;const next=()=>String(++id),r=mockApprovalCommand(db,'auth-1',submit,next);
  db.approval_requests[0].steps_snapshot=null;db.system_settings[0].value={approvals:false};
  const out=mockApprovalCommand(db,'auth-1',{commandId:'withdraw-01',operation:'withdraw',requestId:r.request!.id,expectedVersion:1},next);
  expect(out.request?.status).toBe('cancelled');expect(out.task.current_approval_id).toBeNull();
 });
 it('cannot clear a pending requirement or silently replace its snapshot',()=>{
  const db=fixture();let id=0;const next=()=>String(++id);mockApprovalCommand(db,'auth-1',submit,next);
  expect(()=>mockApprovalCommand(db,'auth-1',{commandId:'require-001',operation:'set_requirement',taskId:'task-1',expectedRequiresApproval:true,enabled:false},next)).toThrow('approval_conflict');
  expect(db.tasks[0].requires_approval).toBe(true);
 });
});
