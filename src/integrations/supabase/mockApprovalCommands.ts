// Local demonstration adapter only. It has no network, Slack or production database access.
import {parseApprovalCommand,canonicalApprovalPayload,approvalSnapshotSteps,canActOnApproval,ApprovalCommandError} from '@/lib/approval/core';
import type {ApprovalRequestState,ApprovalCommandResult,ApprovalStepSnapshot} from '@/lib/approval/core';
type Row=Record<string,unknown>;
type Store=Record<string,Row[]>;
export function mockApprovalCommand(store:Store,authId:string|undefined,input:unknown,newId:()=>string):ApprovalCommandResult {
  const command=parseApprovalCommand(input), state=structuredClone(store);
  const rows=(name:string)=>state[name] ?? (state[name]=[]);
  const fail=(code:string):never=>{throw new ApprovalCommandError('approval_'+code);};
  const actor=rows('members').find(row=>row.auth_id===authId && row.is_active!==false);
  if(!actor) return fail('forbidden');
  const prior=rows('approval_commands').find(row=>row.id===command.commandId);
  const fingerprint=canonicalApprovalPayload(command);
  if(prior){
    if(prior.actor_id!==actor.id || prior.fingerprint!==fingerprint) return fail('idempotency_conflict');
    return {...structuredClone(prior.result as ApprovalCommandResult),replayed:true};
  }
  const setting=rows('system_settings').find(row=>row.key==='feature_toggles')?.value;
  const flags=(typeof setting==='string'?JSON.parse(setting):setting) as {approvals?:unknown}|undefined;
  const enabled=typeof flags?.approvals==='boolean'?flags.approvals:rows('approval_rules').length>0||rows('approval_requests').length>0;
  if(command.operation!=='withdraw'&&!enabled) return fail('disabled');
  let request:ApprovalRequestState|null=null;
  if('requestId' in command){
    request=rows('approval_requests').find(row=>row.id===command.requestId) as unknown as ApprovalRequestState ?? null;
    if(!request) return fail('unavailable');
    if(request.version!==command.expectedVersion) return fail('conflict');
  }
  const task=rows('tasks').find(row=>row.id===('taskId' in command?command.taskId:request!.task_id));
  if(!task) return fail('unavailable');
  const pending=rows('approval_requests').find(row=>row.task_id===task.id&&row.status==='pending');
  const now=new Date().toISOString(),eventId=newId();
  const project=rows('projects').find(row=>row.id===task.project_id);
  if(command.operation!=='withdraw'&&(!project||project.is_archived)) return fail('unavailable');
  const prerequisite=(to:string)=>{
    if(!rows('statuses').some(row=>row.id===to)) return fail('unavailable');
    if(rows('status_transition_rules').some(row=>row.target_status_id===to&&!rows('status_logs').some(log=>log.task_id===task.id&&log.to_status_id===row.required_status_id))) return fail('transition_prerequisite');
  };
  if(command.operation==='set_requirement'){
    if(pending||task.current_approval_id||task.approval_status==='pending_approval'||!!task.requires_approval!==command.expectedRequiresApproval) return fail('conflict');
    task.requires_approval=command.enabled;
  }else if(command.operation==='submit'){
    const e=command.expected;
    if(pending||task.current_approval_id||task.approval_status==='pending_approval'||task.status_id!==e.statusId||
      !!task.requires_approval!==e.requiresApproval||(task.current_approval_id??null)!==e.currentApprovalId||(task.approval_status??null)!==e.approvalStatus||e.statusId===command.toStatusId) return fail('conflict');
    prerequisite(command.toStatusId);
    const rules=rows('approval_rules').filter(row=>row.project_id===task.project_id&&row.from_status===e.statusId&&row.to_status===command.toStatusId&&row.is_active);
    if(rules.length>1) return fail('rule_invalid');
    const rule=rules[0]??null;if((rule?.id??null)!==command.expectedRuleId) return fail('conflict');
    const steps=(rule?rows('approval_rule_steps').filter(row=>row.rule_id===rule.id):[{step_order:1,approver_type:'role',approver_role:'admin',approver_user_id:null}]) as unknown as ApprovalStepSnapshot[];
    if(!approvalSnapshotSteps({steps_snapshot:steps})||steps.some(step=>step.approver_type==='user'&&!rows('members').some(row=>row.id===step.approver_user_id&&row.is_active!==false))) return fail('rule_invalid');
    request={id:newId(),task_id:String(task.id),rule_id:rule?String(rule.id):null,requested_by:String(actor.id),from_status:e.statusId,to_status:command.toStatusId,current_step:1,status:'pending',version:1,steps_snapshot:structuredClone(steps),rule_snapshot:rule,created_at:now,completed_at:null};
    rows('approval_requests').push(request as unknown as Row);
    task.current_approval_id=request.id;task.approval_status='pending_approval';
    if(command.enableRequirement)task.requires_approval=true;
  }else{
    if(!request||request.status!=='pending'||task.current_approval_id!==request.id||task.status_id!==request.from_status) return fail('conflict');
    if(command.operation==='withdraw'){
      if(actor.id!==request.requested_by&&!['admin','super_admin'].includes(String(actor.role))) return fail('forbidden');
      request.status='cancelled';
    }else{
      if(request.current_step!==command.expectedStep)return fail('conflict');
      if(!approvalSnapshotSteps(request))return fail('legacy_request');
      if(!canActOnApproval(request,{id:String(actor.id),role:String(actor.role)}))return fail('forbidden');
      rows('approval_actions').push({id:newId(),request_id:request.id,step_order:request.current_step,action_by:actor.id,action:command.operation,comment:command.comment,acted_at:now,command_id:command.commandId});
      if(command.operation==='approve'){
        const steps=approvalSnapshotSteps(request)!;
        if(request.current_step<steps.length)request.current_step++;
        else{
          prerequisite(request.to_status);request.status='approved';
          const target=rows('statuses').find(row=>row.id===request!.to_status)!;
          const from=rows('statuses').find(row=>row.id===task.status_id);
          if(target.auto_start&&!task.started_at)task.started_at=now.slice(0,10);
          if(target.is_done&&!from?.is_done)task.completed_at=now;
          if(!target.is_done&&from?.is_done)task.completed_at=null;
          rows('status_logs').push({id:newId(),task_id:task.id,from_status_id:task.status_id,to_status_id:target.id,changed_by:actor.id,changed_at:now});
          task.status_id=target.id;
        }
      }else request.status=command.operation==='reject'?'rejected':'returned';
    }
    request.version++;
    if(request.status!=='pending'){request.completed_at=now;task.current_approval_id=null;task.approval_status=null;}
  }
  rows('activity_logs').push({id:eventId,user_id:actor.id,action_type:'approval_'+command.operation,task_id:task.id,created_at:now});
  const result:ApprovalCommandResult={commandId:command.commandId,replayed:false,eventId,request:structuredClone(request),task:{id:String(task.id),status_id:String(task.status_id),requires_approval:!!task.requires_approval,approval_status:task.approval_status as string??null,current_approval_id:task.current_approval_id as string??null,started_at:task.started_at as string??null,completed_at:task.completed_at as string??null}};
  rows('approval_commands').push({id:command.commandId,actor_id:actor.id,fingerprint,result:structuredClone(result)});
  // Replace only once, after every validation/mutation succeeded.
  for(const [name,value] of Object.entries(state))store[name]=value;
  return result;
}
