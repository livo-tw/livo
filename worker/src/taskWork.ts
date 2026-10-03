import type { Context } from 'hono';
import type { AppContext, AuthCtx, Env } from './env';
import { sha256Hex } from './auth';
import { notifyChanges } from './notify';
import { qaReadBody } from './qa';
import { QaError } from './qa/domain';
import { canonicalTaskWorkPayload, parseTaskWorkCommand, taskWorkError, TaskWorkError, type TaskWorkResult } from './taskWorkCore';
import type { ChangeEvent } from './protocol';

type Receipt = { actor_id: string; task_id: string; payload_hash: string; command: string; result_json: string };
async function liveTask(env: Env, auth: AuthCtx, taskId: string) {
  const found = await env.DB.prepare(`SELECT t.id,t.task_key,t.project_id,t.parent_task_id,t.title,t.status_id,t.priority,t.assignee_id,t.reviewer_id,t.assignee_revision,t.reviewer_revision,t.assignee_acknowledged_at,t.reviewer_acknowledged_at FROM tasks t JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id
    JOIN members m ON m.workspace_id=t.workspace_id AND m.id=? AND m.auth_id=? AND m.is_active=1
    JOIN auth_users u ON u.id=m.auth_id AND COALESCE(u.banned,0)=0
    WHERE t.workspace_id=? AND t.id=? AND p.is_archived=0
    AND (SELECT count(*) FROM members WHERE workspace_id=m.workspace_id AND auth_id=m.auth_id AND is_active=1)=1`)
    .bind(auth.member.id, auth.userId, auth.member.workspaceId, taskId).first();
  if (!found) throw new TaskWorkError('work_unavailable',404);
  return found;
}
const receipt = (env: Env, workspace: string, commandId: string) => env.DB.prepare(
  'SELECT actor_id,task_id,payload_hash,command,result_json FROM task_work_receipts WHERE workspace_id=? AND id=?')
  .bind(workspace,commandId).first<Receipt>();
export async function executeTaskWorkCommand(env: Env, auth: AuthCtx, input: unknown): Promise<TaskWorkResult> {
  const command=parseTaskWorkCommand(input), canonical=canonicalTaskWorkPayload(command), hash=await sha256Hex(canonical);
  const ws=auth.member.workspaceId;
  await liveTask(env,auth,command.taskId);
  const replay = async (prior: Receipt): Promise<TaskWorkResult> => {
    const current=await liveTask(env,auth,prior.task_id);
    if (prior.actor_id!==auth.member.id || prior.payload_hash!==hash || prior.command!==canonical || prior.task_id!==command.taskId)
      throw new TaskWorkError('work_command_reused',409);
    return { ...JSON.parse(prior.result_json), replayed:true, task:current };
  };
  const prior=await receipt(env,ws,command.commandId);
  if (prior) return replay(prior);
  try {
    await env.DB.prepare(`INSERT INTO task_work_contexts(workspace_id,id,auth_id,actor_id,task_id,operation,payload,payload_hash,event_id,record_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(ws,command.commandId,auth.userId,auth.member.id,command.taskId,command.operation,canonical,hash,
      crypto.randomUUID(),crypto.randomUUID(),new Date().toISOString()).run();
  } catch (error) {
    const raced=await receipt(env,ws,command.commandId);
    if (raced) return replay(raced);
    throw taskWorkError(error);
  }
  const saved=await receipt(env,ws,command.commandId);
  if (!saved) throw new TaskWorkError('work_unavailable',503);
  await liveTask(env,auth,command.taskId);
  return JSON.parse(saved.result_json) as TaskWorkResult;
}
/** Generic clients may change assignments, but never forge their receipt fields. */
export function taskWorkGenericPatch(table: string, value: Record<string,unknown>) {
  const protectedFields=table==='tasks' ? ['assignee_revision','reviewer_revision','assignee_acknowledged_at','reviewer_acknowledged_at']
    : ['task_checks','task_todos'].includes(table) ? ['version'] : [];
  if (protectedFields.some(key=>Object.prototype.hasOwnProperty.call(value,key))) throw new TaskWorkError('work_forbidden',403);
  return value;
}
export async function handleTaskWorkCommand(c: Context<AppContext>): Promise<Response> {
  try {
    const input=JSON.parse(new TextDecoder().decode(await qaReadBody(c,32768)));
    const command=parseTaskWorkCommand(input), result=await executeTaskWorkCommand(c.env,c.get('auth'),command);
    if (!result.replayed) {
      const table=command.operation==='create_subtask'?'tasks':command.operation.includes('dependency')?'task_dependencies'
        :'list' in command?`task_${command.list}`:'tasks';
      const deleted=command.operation==='delete_item'||command.operation==='remove_dependency';
      const event: ChangeEvent={table,eventType:deleted?'DELETE':command.operation.startsWith('add_')||command.operation==='create_subtask'?'INSERT':'UPDATE',
        new:deleted?null:result.record||{...result.task},old:deleted?{id:result.removedId,task_id:command.taskId}:null};
      notifyChanges(c.env,c.executionCtx,[event],c.get('auth').member.workspaceId);
    }
    return c.json(result);
  } catch (error) {
    const e=error instanceof SyntaxError?new TaskWorkError('work_invalid_input'):error instanceof QaError&&error.code==='qa_request_too_large'
      ?new TaskWorkError('work_invalid_input',413):taskWorkError(error);
    return c.json({error:e.code},e.status as 400);
  }
}

/** SQLite RETURNING precedes AFTER triggers. Read back generated revisions before
 * responding or emitting realtime, without trusting the submitted version. */
export async function taskWorkReadback(env:Env,table:string,workspace:string,rows:Record<string,unknown>[]) {
  if(!['tasks','task_checks','task_todos'].includes(table)||!rows.length)return rows;
  const fresh=new Map<string,Record<string,unknown>>();
  for(let i=0;i<rows.length;i+=100){const ids=rows.slice(i,i+100).map(row=>String(row.id));
    const result=await env.DB.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id IN (${ids.map(()=>'?').join(',')})`).bind(workspace,...ids).all<Record<string,unknown>>();
    for(const row of result.results)fresh.set(String(row.id),row);
  }
  return rows.map(row=>fresh.get(String(row.id))||row);
}
