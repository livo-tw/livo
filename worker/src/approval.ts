import type { Context } from 'hono';
import type { AppContext, AuthCtx, Env } from './env';
import { notifyChanges } from './notify';
import { sha256Hex } from './auth';
import { qaReadBody } from './qa';
import { QaError } from './qa/domain';
import { ApprovalCommandError, canonicalApprovalPayload, parseApprovalCommand, type ApprovalCommandResult } from './approval/core';
import { runApprovalDeliveries } from './approvalDelivery';
import type { ChangeEvent } from './protocol';
import { withFullTaskRows } from './taskEvents';

type C = Context<AppContext>;
type Receipt = { actor_id: string; task_id: string; payload_hash: string; result_json: string };
async function visibleTask(env: Env, auth: AuthCtx, taskId: string,allowArchived=false): Promise<void> {
  const row = await env.DB.prepare(`SELECT t.id FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id
    JOIN members m ON m.workspace_id=t.workspace_id AND m.id=? AND m.is_active=1
    WHERE t.workspace_id=? AND t.id=? ${allowArchived?'':'AND p.is_archived=0'}`).bind(auth.member.id,auth.member.workspaceId,taskId).first();
  if (!row) throw new ApprovalCommandError('approval_unavailable',404);
}
async function getReceipt(env: Env, ws: string, id: string): Promise<Receipt | null> {
  return env.DB.prepare('SELECT actor_id,task_id,payload_hash,result_json FROM approval_command_receipts WHERE workspace_id=? AND id=?')
    .bind(ws,id).first<Receipt>();
}
async function replay(env: Env, auth: AuthCtx, prior: Receipt, hash: string,allowArchived=false): Promise<ApprovalCommandResult> {
  await visibleTask(env,auth,prior.task_id,allowArchived);
  if (prior.actor_id!==auth.member.id || prior.payload_hash!==hash) throw new ApprovalCommandError('approval_idempotency_conflict',409);
  return {...JSON.parse(prior.result_json),replayed:true};
}
export function approvalError(error: unknown): ApprovalCommandError {
  if (error instanceof ApprovalCommandError) return error;
  const statuses: Record<string,number>={approval_forbidden:403,approval_disabled:403,approval_unavailable:404,
    approval_self_decision_forbidden:403,approval_requirement_admin_only:403,
    approval_conflict:409,approval_idempotency_conflict:409,approval_rule_in_use:409,
    approval_invalid_input:400,approval_rule_invalid:400,approval_not_required:400,approval_transition_prerequisite:400};
  const code=(error instanceof Error?error.message:String(error)).match(/\bapproval_[a-z_]+\b/)?.[0];
  if (code && Object.hasOwn(statuses,code)) return new ApprovalCommandError(code,statuses[code]);
  return new ApprovalCommandError('approval_unavailable',503);
}
/** One INSERT executes validation, domain writes, notifications and receipt in
 * one SQLite statement. No zero-row check after an already committed batch. */
export async function executeApprovalCommand(env: Env, auth: AuthCtx, input: unknown): Promise<ApprovalCommandResult> {
  const command=parseApprovalCommand(input), ws=auth.member.workspaceId;
  const canonical=canonicalApprovalPayload(command), hash=await sha256Hex(canonical);
  const prior=await getReceipt(env,ws,command.commandId);
  if (prior) return replay(env,auth,prior,hash,command.operation==='withdraw');
  let taskId: string, requestId: string | null;
  if ('taskId' in command) {taskId=command.taskId;requestId=command.operation==='submit'?crypto.randomUUID():null;}
  else {
    const request=await env.DB.prepare('SELECT task_id FROM approval_requests WHERE workspace_id=? AND id=?').bind(ws,command.requestId).first<{task_id:string}>();
    if (!request) throw new ApprovalCommandError('approval_unavailable',404);
    taskId=request.task_id;requestId=command.requestId;
  }
  await visibleTask(env,auth,taskId,command.operation==='withdraw');
  try {
    await env.DB.prepare(`INSERT INTO approval_command_contexts(workspace_id,id,actor_id,task_id,request_id,operation,payload,payload_hash,event_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(ws,command.commandId,auth.member.id,taskId,requestId,command.operation,canonical,hash,crypto.randomUUID(),new Date().toISOString()).run();
  } catch (error) {
    const raced=await getReceipt(env,ws,command.commandId);
    if (raced) return replay(env,auth,raced,hash,command.operation==='withdraw');
    throw approvalError(error);
  }
  const saved=await getReceipt(env,ws,command.commandId);
  if (!saved) throw new ApprovalCommandError('approval_unavailable',503);
  // Recheck visibility before returning any historic command body.
  await visibleTask(env,auth,taskId,command.operation==='withdraw');
  return JSON.parse(saved.result_json) as ApprovalCommandResult;
}
export async function handleApprovalCommand(c: C): Promise<Response> {
  try {
    const input=JSON.parse(new TextDecoder().decode(await qaReadBody(c,32768)));
    const result=await executeApprovalCommand(c.env,c.get('auth'),input);
    if (!result.replayed) {
      const events:ChangeEvent[]=[{table:'tasks',eventType:'UPDATE',new:{...result.task},old:null}];
      if(result.request) events.push({table:'approval_requests',eventType:'UPDATE',new:{...result.request},old:null});
      const ws=c.get('auth').member.workspaceId;
      notifyChanges(c.env,c.executionCtx,await withFullTaskRows(c.env,ws,events),ws);
      c.executionCtx.waitUntil(runApprovalDeliveries(c.env,c.get('auth').member.workspaceId).catch(()=>console.error('approval_delivery_unavailable')));
    }
    return c.json(result);
  } catch(error) {const e=error instanceof SyntaxError?new ApprovalCommandError('approval_invalid_input'):
    error instanceof QaError&&error.code==='qa_request_too_large'?new ApprovalCommandError('approval_request_too_large',413):approvalError(error);
    return c.json({error:e.code},e.status as 400);}
}
