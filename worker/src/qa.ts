import type { Context } from 'hono';
import type { AppContext, AuthCtx, Ctx, Env } from './env';
import { DEMO_BLOCKED_MESSAGE, isDemoMember } from './env';
import { notifyChanges } from './notify';
import { syncQaSlackIssue } from './qaSlackSync';
import { parseQaWorkflow, validateQaWorkflow } from './qa/workflow';
import {
  applyQaCommand, canQaCommand, createQaIssue, qaEventDetail, QaError, QA_STATES,
  type QaCommand, type QaContext, type QaIssue, type QaComment, type QaEvent,
  type QaListInput, type QaCreateInput,
} from './qa/domain';
import { handleQaStorage, qaAttachmentWire, qaFileInput } from './qaStorage';

type C = Context<AppContext>;
type Body = Record<string, unknown>;
export function qaId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new QaError('qa_invalid_id');
  return value;
}
export async function qaReadBody(c: C, limit = 262144): Promise<Uint8Array> {
  const stream = c.req.raw.body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new QaError('qa_request_too_large', 413); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export async function requireQaEnabled(env: Env, ws: string): Promise<void> {
  const row = await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='feature_toggles'").bind(ws).first<{value:string}>();
  let enabled = false;
  try { enabled = !!row && JSON.parse(row.value)?.qa === true; } catch { /* disabled */ }
  if (!enabled) throw new QaError('qa_disabled', 403);
}
export async function getQaIssue(env: Env, ws: string, id: string): Promise<QaIssue> {
  const row = await env.DB.prepare('SELECT q.data FROM qa_issues q JOIN projects p ON p.workspace_id=q.workspace_id AND p.id=q.project_id WHERE q.workspace_id=? AND q.id=?').bind(ws,id).first<{data:string}>();
  if (!row) throw new QaError('qa_not_found',404);
  return JSON.parse(row.data) as QaIssue;
}
export function canonicalQaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalQaJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonicalQaJson(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export async function qaHash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
async function context(env: Env, auth: AuthCtx, projectId: string, taskIds: string[], duplicateId?: string): Promise<QaContext> {
  const ws=auth.member.workspaceId;
  const [members, project, tasks, duplicate] = await Promise.all([
    env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND is_active=1').bind(ws).all<{id:string}>(),
    env.DB.prepare('SELECT id FROM projects WHERE workspace_id=? AND id=? AND is_archived=0').bind(ws,projectId).first<{id:string}>(),
    taskIds.length ? env.DB.prepare(`SELECT id FROM tasks WHERE workspace_id=? AND project_id=? AND id IN (${taskIds.map(()=>'?').join(',')})`).bind(ws,projectId,...taskIds).all<{id:string}>() : Promise.resolve({results:[]}),
    duplicateId ? env.DB.prepare('SELECT id FROM qa_issues WHERE workspace_id=? AND project_id=? AND id=?').bind(ws,projectId,duplicateId).first<{id:string}>() : Promise.resolve(null),
  ]);
  return {actor:{id:auth.member.id,role:auth.member.role},workspaceId:ws,now:new Date().toISOString(),newId:()=>crypto.randomUUID(),
    memberIds:new Set(members.results.map(r=>r.id)),projectIds:new Set(project?[project.id]:[]),taskIds:new Set(tasks.results.map(r=>r.id)),duplicateIssueIds:new Set(duplicate?[duplicate.id]:[])};
}
async function receipt(env: Env, ws: string, commandId: string, hash: string, actor: string): Promise<unknown | undefined> {
  const row = await env.DB.prepare('SELECT request_hash,result_json,actor_id FROM qa_commands WHERE workspace_id=? AND id=?').bind(ws,commandId).first<{request_hash:string;result_json:string;actor_id:string}>();
  if (!row) return undefined;
  if (row.request_hash!==hash || row.actor_id!==actor) throw new QaError('qa_idempotency_conflict',409);
  return JSON.parse(row.result_json);
}
function sqlError(err: unknown): QaError {
  const message=err instanceof Error?err.message:String(err);
  const code=message.match(/qa_[a-z_]+/)?.[0];
  if(code) return new QaError(code,code==='qa_disabled'||code==='qa_forbidden'?403:code.includes('conflict')?409:400);
  if(/UNIQUE constraint|constraint failed/i.test(message)) return new QaError('qa_conflict',409);
  return new QaError('qa_internal_error',500);
}
export function qaErrorResponse(c:C, err:unknown): Response {
  const e=err instanceof QaError?err:sqlError(err);
  if(e.status>=500) console.error('[qa]',err);
  return c.json({error:{code:e.code,message:e.code}},e.status as 400);
}
async function commit(c:C, commandId:string, hash:string, before:QaIssue|null, after:QaIssue, type:string, result:unknown, comment?:QaComment):Promise<unknown> {
  const env=c.env, auth=c.get('auth'), ws=auth.member.workspaceId, now=new Date().toISOString();
  const event:QaEvent={id:crypto.randomUUID(),issueId:after.id,actorId:auth.member.id,type,detail:type,version:after.version,createdAt:now};
  const statements:D1PreparedStatement[]=[env.DB.prepare('INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,expected_version,operation,request_hash,issue_data,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(ws,commandId,after.id,auth.member.id,auth.member.role,before?.version??-1,type,hash,JSON.stringify(after),JSON.stringify(result),now)];
  const fields=[after.projectId,after.state,after.assigneeId,after.qaOwnerId,after.reporterId,after.title,after.version,after.updatedAt,JSON.stringify(after)];
  if(!before) statements.push(env.DB.prepare('INSERT INTO qa_issues(project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data,workspace_id,id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(...fields,ws,after.id));
  else statements.push(env.DB.prepare('UPDATE qa_issues SET project_id=?,state=?,assignee_id=?,qa_owner_id=?,reporter_id=?,title=?,version=?,updated_at=?,data=? WHERE workspace_id=? AND id=? AND version=?').bind(...fields,ws,after.id,before.version));
  if(comment) statements.push(env.DB.prepare('INSERT INTO qa_comments(workspace_id,id,issue_id,actor_id,body,created_at) VALUES(?,?,?,?,?,?)').bind(ws,comment.id,after.id,auth.member.id,comment.body,comment.createdAt));
  statements.push(env.DB.prepare('INSERT INTO qa_events(workspace_id,id,issue_id,actor_id,type,detail,version,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(ws,event.id,after.id,event.actorId,type,comment?'comment':qaEventDetail(after,type),after.version,now));
  // Durable in-app notifications are inserted in this same transaction. Realtime is only a wake-up.
  const recipients=new Set<string>();
  if(type==='create') {
    const admins=await env.DB.prepare("SELECT id FROM members WHERE workspace_id=? AND is_active=1 AND role IN ('admin','super_admin')").bind(ws).all<{id:string}>(); admins.results.forEach(r=>recipients.add(r.id));
  } else if(type==='triage'||type==='reopen'||(type==='record_verification'&&after.state==='in_progress')) {if(after.assigneeId)recipients.add(after.assigneeId);}
  else if(type==='record_deployment'||type==='submit_fix') {if(after.qaOwnerId)recipients.add(after.qaOwnerId);}
  else if(type==='close') recipients.add(after.reporterId);
  else if(type==='comment') {recipients.add(after.reporterId);if(after.assigneeId)recipients.add(after.assigneeId);if(after.qaOwnerId)recipients.add(after.qaOwnerId);}
  recipients.delete(auth.member.id);
  for(const recipient of recipients) statements.push(env.DB.prepare("INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,task_id,content,is_read,created_at) SELECT ?,?,?,?,'qa_update',NULL,?,0,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1)").bind(ws,crypto.randomUUID(),recipient,auth.member.id,JSON.stringify({kind:'qa',issueId:after.id,title:after.title,event:type}),now,ws,recipient));
  try { await env.DB.batch(statements); }
  catch(err) {const prior=await receipt(env,ws,commandId,hash,auth.member.id);if(prior!==undefined)return prior;throw sqlError(err);}
  // Never make the client retry a committed command because the transport wake-up failed.
  try {notifyChanges(env,c.executionCtx,[{table:'qa_issues',eventType:before?'UPDATE':'INSERT',new:{id:after.id,workspace_id:ws,project_id:after.projectId,version:after.version},old:null}],ws);}catch{/* polling/readback still works */}
  try {c.executionCtx.waitUntil(syncQaSlackIssue(env,ws,after).catch(()=>console.error('qa_slack_sync_failed')));}catch{/* committed state never depends on Slack */}
  return result;
}
async function list(env:Env,ws:string,actor:string,input:QaListInput) {
  const clauses=['q.workspace_id=?'], params:(string|number)[]=[ws];
  if(input.projectId){clauses.push('q.project_id=?');params.push(qaId(input.projectId));}
  if(input.state){if(!QA_STATES.includes(input.state))throw new QaError('qa_invalid_state');clauses.push('q.state=?');params.push(input.state);}
  if(input.search){if(typeof input.search!=='string'||input.search.length>200)throw new QaError('qa_invalid_search');clauses.push("q.title LIKE ? ESCAPE '\\'");params.push(`%${input.search.replace(/[\\%_]/g,'\\$&')}%`);}
  const mine={assigned:'assignee_id',testing:'qa_owner_id',reported:'reporter_id'};
  if(input.mine){if(!Object.prototype.hasOwnProperty.call(mine,input.mine))throw new QaError('qa_invalid_filter');clauses.push(`q.${mine[input.mine]}=?`);params.push(actor);}
  const limit=Math.max(1,Math.min(100,Number.isSafeInteger(input.limit)?input.limit!:50));
  const offset=Math.max(0,Number.isSafeInteger(input.offset)?input.offset!:0);
  const where=clauses.join(' AND '), join=' FROM qa_issues q JOIN projects p ON p.workspace_id=q.workspace_id AND p.id=q.project_id ';
  const [rows,count]=await Promise.all([env.DB.prepare(`SELECT q.data${join}WHERE ${where} ORDER BY q.updated_at DESC,q.id LIMIT ? OFFSET ?`).bind(...params,limit,offset).all<{data:string}>(),env.DB.prepare(`SELECT COUNT(*) AS total${join}WHERE ${where}`).bind(...params).first<{total:number}>()]);
  const issues=rows.results.map(r=>JSON.parse(r.data) as QaIssue),total=count?.total??0;
  return {issues,total,hasMore:offset+issues.length<total};
}
const RESTORE_COLUMNS:Record<string,string[]>={
  qa_issues:['workspace_id','id','project_id','state','assignee_id','qa_owner_id','reporter_id','title','version','updated_at','data'],
  qa_comments:['workspace_id','id','issue_id','actor_id','body','created_at'],
  qa_events:['workspace_id','id','issue_id','actor_id','type','detail','version','created_at'],
  qa_attachments:['workspace_id','id','issue_id','uploaded_by','file_name','mime_type','size','storage_key','created_at'],
  qa_commands:['workspace_id','id','issue_id','actor_id','actor_role','expected_version','operation','request_hash','issue_data','result_json','created_at'],
  qa_slack_links:['workspace_id','id','issue_id','team_id','channel_id','thread_ts','card_ts','created_at'],
};
const RESTORE_JSON=new Set(['data','issue_data','result_json']);
async function restore(c:C,body:Body):Promise<unknown>{
  const auth=c.get('auth'),ws=auth.member.workspaceId;
  if(auth.member.role!=='super_admin')throw new QaError('qa_forbidden',403);
  if(!body.tables||typeof body.tables!=='object'||Array.isArray(body.tables))throw new QaError('qa_invalid_backup');
  const tables=body.tables as Record<string,unknown>,validateOnly=body.validateOnly!==false;
  const conflicts:string[]=[],missingAssets:string[]=[],rows:Array<{table:string;row:Record<string,unknown>}>=[];
  const sourceIssues=new Map<string,QaIssue>();let skipped=0;
  for(const [table,columns] of Object.entries(RESTORE_COLUMNS)){
    const input=tables[table];if(input===undefined)continue;if(!Array.isArray(input))throw new QaError('qa_invalid_backup');
    for(const raw of input){
      if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new QaError('qa_invalid_backup');
      const row:Record<string,unknown>={};
      for(const col of columns){const value=(raw as Record<string,unknown>)[col];
        if(RESTORE_JSON.has(col)){try{if(value===undefined||value===null)throw new Error();row[col]=canonicalQaJson(typeof value==='string'?JSON.parse(value):value);}catch{throw new QaError('qa_invalid_backup');}}
        else row[col]=value??null;
      }
      if(row.workspace_id!==ws)throw new QaError('qa_backup_workspace_mismatch',403);
      qaId(row.id);if('issue_id'in row)qaId(row.issue_id);
      if(Object.values(row).some(v=>v!==null&&typeof v!=='string'&&typeof v!=='number'))throw new QaError('qa_invalid_backup');
      if(table==='qa_issues'){
        const issue=JSON.parse(String(row.data)) as QaIssue;
        if(!issue||issue.id!==row.id||issue.workspaceId!==ws||issue.projectId!==row.project_id||issue.state!==row.state||issue.version!==row.version||issue.title!==row.title||issue.assigneeId!==row.assignee_id||issue.qaOwnerId!==row.qa_owner_id||issue.reporterId!==row.reporter_id||issue.updatedAt!==row.updated_at||!QA_STATES.includes(issue.state)||!Number.isSafeInteger(issue.version)||issue.version<1||!Number.isSafeInteger(issue.fixCycle)||issue.fixCycle<0||!Array.isArray(issue.targets)||!Array.isArray(issue.runs)||!Array.isArray(issue.taskIds)||issue.targets.length>30||issue.runs.length>2000||issue.taskIds.length>50||typeof issue.title!=='string'||typeof issue.actual!=='string'||JSON.stringify(issue).length>1500000)throw new QaError('qa_invalid_backup_issue');
        const ctx=await context(c.env,auth,qaId(issue.projectId),issue.taskIds);
        if(!ctx.projectIds.has(issue.projectId)||issue.taskIds.some(id=>!ctx.taskIds.has(id))||[issue.assigneeId,issue.qaOwnerId].some(id=>id!==null&&!ctx.memberIds.has(id)))throw new QaError('qa_backup_reference_unavailable');
        if(sourceIssues.has(issue.id))throw new QaError('qa_duplicate_backup_row');sourceIssues.set(issue.id,issue);
      }
      rows.push({table,row});if(rows.length>5000)throw new QaError('qa_backup_batch_too_large',413);
    }
  }
  // References can target an existing issue or one restored earlier in the same transaction.
  for(const {table,row} of rows){
    if(table==='qa_issues')continue;
    if(!sourceIssues.has(String(row.issue_id)))await getQaIssue(c.env,ws,String(row.issue_id));
  }
  const pending:Array<{table:string;row:Record<string,unknown>}>=[];
  for(const item of rows){
    const {table,row}=item,columns=RESTORE_COLUMNS[table];
    if(table==='qa_attachments'){
      qaFileInput(row.file_name,row.mime_type,row.size);
      const path=String(row.storage_key),expected=`qa/${ws}/${row.issue_id}/${row.id}`;
      if(path!==expected)throw new QaError('qa_backup_asset_scope',403);
      const object=await c.env.ATTACHMENTS.head(path);
      if(!object||object.size!==row.size||object.customMetadata?.workspace!==ws||object.customMetadata?.upload!==row.id||object.customMetadata?.issue!==row.issue_id||object.httpMetadata?.contentType!==row.mime_type){missingAssets.push(String(row.id));continue;}
    }
    const existing=await c.env.DB.prepare(`SELECT ${columns.join(',')} FROM ${table} WHERE workspace_id=? AND id=?`).bind(ws,row.id as string).first<Record<string,unknown>>();
    if(existing){
      for(const col of columns)if(RESTORE_JSON.has(col))existing[col]=canonicalQaJson(typeof existing[col]==='string'?JSON.parse(String(existing[col])):existing[col]);
      if(canonicalQaJson(existing)===canonicalQaJson(row))skipped++;else conflicts.push(`${table}:${row.id}`);
      continue;
    }
    pending.push(item);
  }
  const report={validateOnly,inserted:0,skipped,conflicts,missingAssets,pending:pending.length};
  if(validateOnly||conflicts.length||missingAssets.length||!pending.length)return report;
  const statements=[c.env.DB.prepare('INSERT INTO qa_restore_batches(workspace_id,id,actor_id,created_at) VALUES(?,?,?,?)').bind(ws,crypto.randomUUID(),auth.member.id,new Date().toISOString())];
  for(const {table,row} of pending){
    const columns=[...RESTORE_COLUMNS[table]];
    if(table==='qa_commands'||table==='qa_attachments'){columns.push('restored_by');row.restored_by=auth.member.id;}
    statements.push(c.env.DB.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(col=>row[col] as string|number|null)));
  }
  await c.env.DB.batch(statements);
  return {...report,inserted:pending.length};
}
export async function handleQa(c:C):Promise<Response> {
  try {
    const auth=c.get('auth'),ws=auth.member.workspaceId;
    await requireQaEnabled(c.env,ws);
    const active=await c.env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=? AND role=? AND is_active=1').bind(ws,auth.member.id,auth.member.role).first();
    if(!active)throw new QaError('qa_forbidden',403);
    if(c.req.query('action')==='upload_part') {
      if(isDemoMember(c.env,auth))throw new QaError(DEMO_BLOCKED_MESSAGE,403);
      return await handleQaStorage(c,'upload_part',{});
    }
    let body:Body;try{body=JSON.parse(new TextDecoder().decode(await qaReadBody(c,10*1024*1024)));}catch(e){if(e instanceof QaError)throw e;throw new QaError('qa_invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new QaError('qa_invalid_request');
    const action=String(body.action??'');
    if(!['list','get','download','get_workflow'].includes(action)&&isDemoMember(c.env,auth))throw new QaError(DEMO_BLOCKED_MESSAGE,403);
    if(action==='get_workflow') {
      const row=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_workflow'").bind(ws).first<{value:string}>();
      return c.json(parseQaWorkflow(row?.value));
    }
    if(action==='save_workflow') {
      if(!['admin','super_admin'].includes(auth.member.role))throw new QaError('qa_forbidden',403);
      const workflow=validateQaWorkflow(body.workflow);
      const result=await c.env.DB.prepare(`INSERT INTO system_settings(workspace_id,key,value,updated_at)
        SELECT ?,'qa_workflow',?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND role IN ('admin','super_admin'))
        AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=? AND key='feature_toggles' AND json_extract(value,'$.qa')=1)
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(ws,JSON.stringify(workflow),new Date().toISOString(),ws,auth.member.id,ws).run();
      if(result.meta.changes!==1)throw new QaError('qa_forbidden',403);
      return c.json(workflow);
    }
    if(action==='restore')return c.json(await restore(c,body));
    if(action==='list')return c.json(await list(c.env,ws,auth.member.id,(body.input??{}) as QaListInput));
    if(action==='get') {
      const id=qaId(body.id),issue=await getQaIssue(c.env,ws,id);
      const [comments,events,attachments]=await Promise.all([
        c.env.DB.prepare('SELECT id,issue_id AS issueId,actor_id AS actorId,body,created_at AS createdAt FROM qa_comments WHERE workspace_id=? AND issue_id=? ORDER BY created_at,id').bind(ws,id).all<QaComment>(),
        c.env.DB.prepare('SELECT id,issue_id AS issueId,actor_id AS actorId,type,detail,version,created_at AS createdAt FROM qa_events WHERE workspace_id=? AND issue_id=? ORDER BY version,created_at,id').bind(ws,id).all<QaEvent>(),
        c.env.DB.prepare('SELECT * FROM qa_attachments WHERE workspace_id=? AND issue_id=? ORDER BY created_at,id').bind(ws,id).all(),
      ]);
      return c.json({issue,comments:comments.results,events:events.results,attachments:attachments.results.map(qaAttachmentWire)});
    }
    if(['upload_init','upload_complete','download'].includes(action))return await handleQaStorage(c,action,body);
    if(!['create','command','comment'].includes(action))throw new QaError('qa_invalid_action');
    const id=qaId(body.id),commandId=qaId(body.commandId),hash=await qaHash(canonicalQaJson({...body,actor:auth.member.id}));
    const prior=await receipt(c.env,ws,commandId,hash,auth.member.id);if(prior!==undefined)return c.json(prior);
    if(action==='create') {
      const input=body.input as QaCreateInput;if(!input||typeof input!=='object')throw new QaError('qa_invalid_input');
      const ctx=await context(c.env,auth,qaId(input.projectId),[]),issue=createQaIssue(input,id,ctx);
      return c.json(await commit(c,commandId,hash,null,issue,'create',issue));
    }
    const before=await getQaIssue(c.env,ws,id);
    if(action==='comment') {
      if(!canQaCommand(before,{id:auth.member.id,role:auth.member.role},'edit'))throw new QaError('qa_forbidden',403);
      if(typeof body.body!=='string'||!body.body.trim()||body.body.length>20000)throw new QaError('qa_invalid_comment');
      const now=new Date().toISOString(),comment:QaComment={id:crypto.randomUUID(),issueId:id,actorId:auth.member.id,body:body.body.trim(),createdAt:now};
      const after={...before,version:before.version+1,updatedAt:now};
      return c.json(await commit(c,commandId,hash,before,after,'comment',comment,comment));
    }
    if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion!==before.version)throw new QaError('qa_conflict',409);
    const command=body.command as QaCommand;if(!command||typeof command.type!=='string')throw new QaError('qa_invalid_command');
    const requestedTasks=command.type==='link_tasks'&&Array.isArray(command.taskIds)?command.taskIds:before.taskIds;
    if(requestedTasks.length>100)throw new QaError('qa_too_many_tasks');requestedTasks.forEach(qaId);
    const ctx=await context(c.env,auth,before.projectId,requestedTasks,command.type==='close'?command.duplicateOfId:before.duplicateOfId??undefined);
    const after=applyQaCommand(before,command,ctx);
    return c.json(await commit(c,commandId,hash,before,after,command.type,after));
  }catch(err){return qaErrorResponse(c,err);}
}

/** Trusted adapters (for example verified Slack interactions) reuse every API guard.
 * The caller must resolve AuthCtx from an authenticated active member, never user-supplied roles.
 */
export async function executeQaAction(env:Env,auth:AuthCtx,body:Record<string,unknown>,ctx:Ctx={waitUntil:():void=>{}}):Promise<unknown>{
  const request=new Request('https://internal/api/functions/qa',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const c={env,executionCtx:ctx,get:(key:string)=>key==='auth'?auth:undefined,
    req:{raw:request,query:():undefined=>undefined},
    json:(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}}),
  } as unknown as C;
  const response=await handleQa(c);
  const value=await response.json() as Record<string,unknown>;
  if(!response.ok){const error=value.error as {code?:string;message?:string}|undefined;throw new QaError(error?.code||error?.message||'qa_request_failed',response.status);}
  return value;
}
