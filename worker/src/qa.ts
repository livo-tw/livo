import { parseDeploymentEnvironments } from './qa/environments';
import type { Context } from 'hono';
import type { AppContext, AuthCtx, Ctx, Env } from './env';
import { DEMO_BLOCKED_MESSAGE, isDemoMember } from './env';
import { notifyChanges } from './notify';
import { syncQaSlackIssue } from './qaSlackSync';
import { parseQaWorkflow, validateQaWorkflow } from './qa/workflow';
import { parseQaManualStateVisibility, validateQaManualStateVisibility } from './qa/manualStateVisibility';
import { parseQaDisplaySettings, validateQaDisplaySettings } from './qa/displaySettings';
import { isDeploymentQueueOperator } from './deploymentQueue';
import { canManageQaConfiguration, parseQaFieldConfiguration, validateQaFieldConfiguration } from './qa/fields';
import { qaVersionSuggestions } from './qa/versions';
import {
  applyQaCommand, canQaComment, canQaDelete, createQaIssue, normalizeQaListFilters, qaEventDetail, qaIdSearch, qaNotificationRecipients, validateQaHandoff, QaError, QA_STATES,
  type QaCommand, type QaContext, type QaIssue, type QaComment, type QaEvent,
  type QaListInput, type QaCreateInput,
} from './qa/domain';
import { handleQaStorage, qaAttachmentWire, qaFileInput } from './qaStorage';
import { commandAuthId, liveMemberSql } from './liveMember';

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
async function coordination(env:Env,ws:string,projectId:string,includeArchived=false){
  const project=await env.DB.prepare(`SELECT id FROM projects WHERE workspace_id=? AND id=? ${includeArchived?'':'AND is_archived=0'}`).bind(ws,projectId).first();
  if(!project)throw new QaError('qa_project_unavailable',404);
  const row=await env.DB.prepare('SELECT coordinator_id,version FROM qa_project_coordination WHERE workspace_id=? AND id=?').bind(ws,projectId).first<{coordinator_id:string|null;version:number}>();
  return {projectId,coordinatorId:row?.coordinator_id??null,version:row?.version??0};
}
async function context(env: Env, auth: AuthCtx, projectId: string, taskIds: string[], duplicateId?: string, loadFields = false): Promise<QaContext & { fieldConfigurationRaw?: string | null }> {
  const ws=auth.member.workspaceId;
  const [members, project, tasks, duplicate, environmentRow, fieldRow] = await Promise.all([
    env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND is_active=1').bind(ws).all<{id:string}>(),
    env.DB.prepare('SELECT id FROM projects WHERE workspace_id=? AND id=? AND is_archived=0').bind(ws,projectId).first<{id:string}>(),
    taskIds.length ? env.DB.prepare(`SELECT id FROM tasks WHERE workspace_id=? AND project_id=? AND id IN (${taskIds.map(()=>'?').join(',')})`).bind(ws,projectId,...taskIds).all<{id:string}>() : Promise.resolve({results:[]}),
    duplicateId ? env.DB.prepare('SELECT id FROM qa_issues WHERE workspace_id=? AND project_id=? AND id=?').bind(ws,projectId,duplicateId).first<{id:string}>() : Promise.resolve(null),
    env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='deployment_environments'").bind(ws).first<{value:string}>(),
    loadFields ? env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields'").bind(ws).first<{value:string}>() : Promise.resolve(null),
  ]);
  const [config, deploymentOperator] = await Promise.all([coordination(env,ws,projectId), deploymentQueueOperator(env, auth)]);
  const environments = parseDeploymentEnvironments(environmentRow ? JSON.parse(environmentRow.value) : undefined);
  if (!environments) throw new QaError('qa_invalid_environment');
  return {...(loadFields ? {fieldConfiguration:parseQaFieldConfiguration(fieldRow?.value),fieldConfigurationRaw:fieldRow?.value??null}:{}),environmentValues:environments.values,actor:{id:auth.member.id,role:auth.member.role,deploymentOperator,qaCoordinatorProjectIds:config.coordinatorId===auth.member.id?[projectId]:[]},workspaceId:ws,now:new Date().toISOString(),newId:()=>crypto.randomUUID(),
    memberIds:new Set(members.results.map(r=>r.id)),projectIds:new Set(project?[project.id]:[]),taskIds:new Set(tasks.results.map(r=>r.id)),duplicateIssueIds:new Set(duplicate?[duplicate.id]:[])};
}
export async function deploymentQueueOperator(env: Env, auth: AuthCtx): Promise<boolean> {
  const ws = auth.member.workspaceId;
  const [member, settings] = await Promise.all([
    env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=? AND auth_id=? AND is_active=1').bind(ws,auth.member.id,auth.userId).first(),
    env.DB.prepare("SELECT key,value FROM system_settings WHERE workspace_id=? AND key IN ('deployment_queue','feature_toggles')").bind(ws).all<{key:string;value:string}>(),
  ]);
  if (!member) return false;
  try {
    const values = Object.fromEntries(settings.results.map(row=>[row.key,JSON.parse(row.value)]));
    return isDeploymentQueueOperator(values.deployment_queue, values.feature_toggles, auth.member.id);
  } catch { return false; }
}
async function receipt(env: Env, ws: string, commandId: string, hash: string, actor: string): Promise<unknown | undefined> {
  const row = await env.DB.prepare('SELECT request_hash,result_json,actor_id FROM qa_commands WHERE workspace_id=? AND id=?').bind(ws,commandId).first<{request_hash:string;result_json:string;actor_id:string}>();
  if (!row) return undefined;
  if (row.request_hash!==hash || row.actor_id!==actor) throw new QaError('qa_idempotency_conflict',409);
  return JSON.parse(row.result_json);
}
function sqlError(err: unknown): QaError {
  const message=err instanceof Error?err.message:String(err);
  if (/NOT NULL constraint failed: qa_commands\.request_hash/i.test(message)) return new QaError('qa_configuration_conflict',409);
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
async function commit(c:C, commandId:string, hash:string, before:QaIssue|null, after:QaIssue, type:string, result:unknown, comment?:QaComment, fieldConfigurationRaw?:string|null):Promise<unknown> {
  const env=c.env, auth=c.get('auth'), ws=auth.member.workspaceId, now=new Date().toISOString();
  // The command trigger re-checks the actor's login; a personal API key records its member's login.
  const authId=await commandAuthId(env,auth);
  if(!authId) throw new QaError('qa_forbidden',403);
  const event:QaEvent={id:crypto.randomUUID(),issueId:after.id,actorId:auth.member.id,type,detail:type,version:after.version,createdAt:now};
  // A changed catalog must abort the complete D1 batch, including its receipt.
  // NOT NULL request_hash deliberately turns a stale snapshot into a SQL error.
  const hashSql=fieldConfigurationRaw===undefined?'?':"CASE WHEN (SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields') IS ? THEN ? ELSE NULL END";
  const hashArgs=fieldConfigurationRaw===undefined?[hash]:[ws,fieldConfigurationRaw,hash];
  const statements:D1PreparedStatement[]=[env.DB.prepare(`INSERT INTO qa_commands(workspace_id,id,issue_id,actor_id,actor_role,expected_version,operation,request_hash,issue_data,result_json,created_at,actor_auth_id) VALUES(?,?,?,?,?,?,?,${hashSql},?,?,?,?)`).bind(ws,commandId,after.id,auth.member.id,auth.member.role,before?.version??-1,type,...hashArgs,JSON.stringify(after),JSON.stringify(result),now,authId)];
  const fields=[after.projectId,after.state,after.assigneeId,after.qaOwnerId,after.reporterId,after.title,after.version,after.updatedAt,JSON.stringify(after)];
  if(!before) statements.push(env.DB.prepare('INSERT INTO qa_issues(project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data,workspace_id,id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(...fields,ws,after.id));
  else statements.push(env.DB.prepare('UPDATE qa_issues SET project_id=?,state=?,assignee_id=?,qa_owner_id=?,reporter_id=?,title=?,version=?,updated_at=?,data=? WHERE workspace_id=? AND id=? AND version=?').bind(...fields,ws,after.id,before.version));
  if(comment) statements.push(env.DB.prepare('INSERT INTO qa_comments(workspace_id,id,issue_id,actor_id,body,created_at) VALUES(?,?,?,?,?,?)').bind(ws,comment.id,after.id,auth.member.id,comment.body,comment.createdAt));
  statements.push(env.DB.prepare('INSERT INTO qa_events(workspace_id,id,issue_id,actor_id,type,detail,version,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(ws,event.id,after.id,event.actorId,type,comment?'comment':qaEventDetail(after,type,before),after.version,now));
  // Durable in-app notifications are inserted in this same transaction. Realtime is only a wake-up.
  // Recipients follow the shared rule (qaNotificationRecipients), as on the self-hosted server.
  let triagers:string[]=[];
  if(type==='create'){
    // A new bug goes to the project's active QA coordinator, otherwise to the workspace admins.
    const rows=await env.DB.prepare(`SELECT m.id,CASE WHEN m.id=(SELECT coordinator_id FROM qa_project_coordination WHERE workspace_id=? AND id=?) THEN 1 ELSE 0 END AS coordinator
      FROM members m WHERE m.workspace_id=? AND m.is_active=1 AND (m.role IN ('admin','super_admin') OR m.id=(SELECT coordinator_id FROM qa_project_coordination WHERE workspace_id=? AND id=?))`)
      .bind(ws,after.projectId,ws,ws,after.projectId).all<{id:string;coordinator:number}>();
    const coordinator=rows.results.filter(row=>row.coordinator===1);
    triagers=(coordinator.length?coordinator:rows.results).map(row=>row.id);
  }
  const recipients=qaNotificationRecipients(after,type as QaCommand['type']|'create'|'comment',auth.member.id,triagers);
  for(const recipient of recipients) statements.push(env.DB.prepare("INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,task_id,content,is_read,created_at) SELECT ?,?,?,?,'qa_update',NULL,?,0,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1)").bind(ws,crypto.randomUUID(),recipient,auth.member.id,JSON.stringify({kind:'qa',issueId:after.id,title:after.title,event:type}),now,ws,recipient));
  try { await env.DB.batch(statements); }
  catch(err) {const prior=await receipt(env,ws,commandId,hash,auth.member.id);if(prior!==undefined)return prior;throw sqlError(err);}
  // Never make the client retry a committed command because the transport wake-up failed.
  try {notifyChanges(env,c.executionCtx,[{table:'qa_issues',eventType:before?'UPDATE':'INSERT',new:{id:after.id,workspace_id:ws,project_id:after.projectId,version:after.version},old:null}],ws);}catch{/* polling/readback still works */}
  try {c.executionCtx.waitUntil(syncQaSlackIssue(env,ws,after).catch(()=>console.error('qa_slack_sync_failed')));}catch{/* committed state never depends on Slack */}
  return result;
}
/**
 * Permanently removes a bug with its comments, history, attachments, uploads, Slack
 * links, receipts and in-app notifications, in one D1 transaction. Every statement
 * repeats the version and permission check, so a bug changed or re-triaged meanwhile
 * is left untouched and the caller gets a conflict.
 */
async function deleteIssue(c:C,issue:QaIssue):Promise<{id:string;deleted:true}> {
  const env=c.env,auth=c.get('auth'),ws=auth.member.workspaceId,id=issue.id,now=new Date().toISOString();
  if(!await commandAuthId(env,auth))throw new QaError('qa_forbidden',403);
  const [attachments,uploads]=await Promise.all([
    env.DB.prepare('SELECT storage_key,size,restored_by FROM qa_attachments WHERE workspace_id=? AND issue_id=?').bind(ws,id).all<{storage_key:string;size:number;restored_by:string|null}>(),
    env.DB.prepare('SELECT storage_key,multipart_id,state FROM qa_upload_sessions WHERE workspace_id=? AND issue_id=?').bind(ws,id).all<{storage_key:string;multipart_id:string|null;state:string}>(),
  ]);
  // Only finalized uploads were added to the workspace's used bytes (qa_attachment_finalize).
  const released=attachments.results.filter(row=>row.restored_by===null).reduce((sum,row)=>sum+Number(row.size),0);
  const guard=`EXISTS(SELECT 1 FROM qa_issues q JOIN members m ON m.workspace_id=q.workspace_id AND m.id=? AND m.is_active=1
    WHERE q.workspace_id=? AND q.id=? AND q.version=? AND (m.role IN ('admin','super_admin') OR m.is_qa_admin=1 OR (q.reporter_id=m.id AND q.state='new')))`;
  const g=[auth.member.id,ws,id,issue.version];
  const scoped=(table:string,column='issue_id')=>env.DB.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND ${column}=? AND ${guard}`).bind(ws,id,...g);
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO activity_logs(workspace_id,id,user_id,action,target_type,task_id,task_key,detail,created_at) SELECT ?,?,?,'delete_qa_issue','qa',?,?,?,? WHERE ${guard}`)
      .bind(ws,crypto.randomUUID(),auth.member.id,id,`#${id.slice(-8)}`,issue.title,now,...g), // the app's qaShortId
    env.DB.prepare(`DELETE FROM qa_upload_parts WHERE workspace_id=? AND upload_id IN (SELECT id FROM qa_upload_sessions WHERE workspace_id=? AND issue_id=?) AND ${guard}`).bind(ws,ws,id,...g),
    scoped('qa_upload_sessions'),scoped('qa_attachments'),scoped('qa_comments'),scoped('qa_events'),scoped('qa_slack_links'),scoped('qa_commands'),
    env.DB.prepare(`DELETE FROM notifications WHERE workspace_id=? AND type='qa_update' AND json_valid(content) AND json_extract(content,'$.issueId')=? AND ${guard}`).bind(ws,id,...g),
    env.DB.prepare(`UPDATE workspaces SET storage_used_bytes=MAX(0,storage_used_bytes-?) WHERE id=? AND ? > 0 AND ${guard}`).bind(released,ws,released,...g),
    env.DB.prepare(`DELETE FROM qa_issues WHERE workspace_id=? AND id=? AND version=? AND ${guard}`).bind(ws,id,issue.version,...g),
  ]);
  if(results[results.length-1]?.meta.changes!==1)throw new QaError('qa_conflict',409);
  try {notifyChanges(env,c.executionCtx,[{table:'qa_issues',eventType:'DELETE',new:null,old:{id,workspace_id:ws,project_id:issue.projectId}}],ws);}catch{/* polling/readback still works */}
  // Stored files go after the rows; a failed cleanup leaves an unreferenced object, never a broken bug.
  const keys=[...new Set([...attachments.results,...uploads.results].map(row=>row.storage_key))];
  const cleanup=async()=>{
    for(const upload of uploads.results.filter(row=>row.multipart_id&&row.state!=='complete')){
      try{await env.ATTACHMENTS.resumeMultipartUpload(upload.storage_key,upload.multipart_id!).abort();}catch{/* already finished or gone */}
    }
    for(let i=0;i<keys.length;i+=1000)await env.ATTACHMENTS.delete(keys.slice(i,i+1000));
  };
  try {c.executionCtx.waitUntil(cleanup().catch(()=>console.error('qa_delete_storage_cleanup_failed')));}catch{/* rows are already gone */}
  return {id,deleted:true};
}
async function list(env:Env,ws:string,actor:string,input:QaListInput) {
  const clauses=['q.workspace_id=?'], params:(string|number)[]=[ws];
  if(input.projectId){clauses.push('q.project_id=?');params.push(qaId(input.projectId));}
  if(input.state){if(!QA_STATES.includes(input.state))throw new QaError('qa_invalid_state');clauses.push('q.state=?');params.push(input.state);}
  if(input.states!==undefined){
    if(input.state||!Array.isArray(input.states)||!input.states.length||input.states.length>QA_STATES.length
      ||new Set(input.states).size!==input.states.length||input.states.some(state=>!QA_STATES.includes(state)))throw new QaError('qa_invalid_state');
    clauses.push(`q.state IN (${input.states.map(()=>'?').join(',')})`);params.push(...input.states);
  }
  if(input.search){
    if(typeof input.search!=='string'||input.search.length>200)throw new QaError('qa_invalid_search');
    // "#1a2b3c4d" (the short id on cards) or a full id searches ids; anything else searches titles.
    const idTerm=qaIdSearch(input.search), like=(value:string)=>`%${value.replace(/[\\%_]/g,'\\$&')}%`;
    clauses.push(idTerm?"q.id LIKE ? ESCAPE '\\'":"q.title LIKE ? ESCAPE '\\'");params.push(like(idTerm??input.search));
  }
  const mine={assigned:'assignee_id',testing:'qa_owner_id',reported:'reporter_id'};
  // "involved": any bug the actor fixes, verifies or reported (My QA's default).
  if(input.mine==='involved'){clauses.push('(q.assignee_id=? OR q.qa_owner_id=? OR q.reporter_id=?)');params.push(actor,actor,actor);}
  // "handoff": an open handoff waiting on the actor (My assignments).
  else if(input.mine==='handoff'){clauses.push("json_extract(q.data,'$.handoff.nextOwnerId')=? AND json_extract(q.data,'$.handoff.resolvedAt') IS NULL");params.push(actor);}
  else if(input.mine){if(!Object.prototype.hasOwnProperty.call(mine,input.mine))throw new QaError('qa_invalid_filter');clauses.push(`q.${mine[input.mine as keyof typeof mine]}=?`);params.push(actor);}
  const filters=normalizeQaListFilters(input,qaId);
  const anyOf=(column:string,values:(string|number)[]|undefined)=>{if(values){clauses.push(`${column} IN (${values.map(()=>'?').join(',')})`);params.push(...values);}};
  anyOf('q.project_id',filters.projectIds);anyOf('q.assignee_id',filters.assigneeIds);anyOf('q.qa_owner_id',filters.qaOwnerIds);anyOf('q.reporter_id',filters.reporterIds);
  anyOf("json_extract(q.data,'$.priority')",filters.priorities);anyOf("json_extract(q.data,'$.severity')",filters.severities);
  // Same order as compareQaIssues in qa/domain.ts and the Docker list.
  const dir=filters.direction==='asc'?'ASC':'DESC',tie='q.updated_at DESC,q.id';
  const order=filters.sort==='updated'?`q.updated_at ${dir},q.id`
    :filters.sort==='priority'?`json_extract(q.data,'$.priority') ${filters.direction==='asc'?'DESC':'ASC'},${tie}`
    :filters.sort==='createdAt'?`json_extract(q.data,'$.createdAt') ${dir},${tie}`
    :`(json_extract(q.data,'$.dueDate') IS NULL),json_extract(q.data,'$.dueDate') ${dir},${tie}`;
  const limit=Math.max(1,Math.min(100,Number.isSafeInteger(input.limit)?input.limit!:50));
  const offset=Math.max(0,Number.isSafeInteger(input.offset)?input.offset!:0);
  const where=clauses.join(' AND '), join=' FROM qa_issues q JOIN projects p ON p.workspace_id=q.workspace_id AND p.id=q.project_id ';
  const [rows,count]=await Promise.all([env.DB.prepare(`SELECT q.data${join}WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...params,limit,offset).all<{data:string}>(),env.DB.prepare(`SELECT COUNT(*) AS total${join}WHERE ${where}`).bind(...params).first<{total:number}>()]);
  const issues=rows.results.map(r=>JSON.parse(r.data) as QaIssue),total=count?.total??0;
  return {issues,total,hasMore:offset+issues.length<total};
}
const RESTORE_COLUMNS:Record<string,string[]>={
  qa_issues:['workspace_id','id','project_id','state','assignee_id','qa_owner_id','reporter_id','title','version','updated_at','data'],
  qa_comments:['workspace_id','id','issue_id','actor_id','body','created_at'],
  qa_events:['workspace_id','id','issue_id','actor_id','type','detail','version','created_at'],
  qa_attachments:['workspace_id','id','issue_id','uploaded_by','file_name','mime_type','size','storage_key','created_at'],
  qa_commands:['workspace_id','id','issue_id','actor_id','actor_role','actor_auth_id','expected_version','operation','request_hash','issue_data','result_json','created_at'],
  qa_project_coordination:['workspace_id','id','coordinator_id','version','updated_by','updated_at'],
  qa_coordination_commands:['workspace_id','id','project_id','actor_id','actor_auth_id','payload_hash','expected_version','response','created_at'],
  qa_slack_links:['workspace_id','id','issue_id','team_id','channel_id','thread_ts','card_ts','created_at'],
};
const RESTORE_JSON=new Set(['data','issue_data','result_json','response']);
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
        validateQaHandoff(issue.handoff);
        const ctx=await context(c.env,auth,qaId(issue.projectId),issue.taskIds);
        if(!ctx.projectIds.has(issue.projectId)||issue.taskIds.some(id=>!ctx.taskIds.has(id))||[issue.assigneeId,issue.qaOwnerId].some(id=>id!==null&&!ctx.memberIds.has(id)))throw new QaError('qa_backup_reference_unavailable');
        for(const person of [issue.handoff?.nextOwnerId,issue.handoff?.requestedBy,issue.handoff?.acceptedBy,issue.handoff?.resolvedBy].filter(Boolean))if(!await c.env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=?').bind(ws,person!).first())throw new QaError('qa_backup_reference_unavailable');
        if(sourceIssues.has(issue.id))throw new QaError('qa_duplicate_backup_row');sourceIssues.set(issue.id,issue);
      }
      if(table==='qa_project_coordination'||table==='qa_coordination_commands'){
        const pid=table==='qa_project_coordination'?String(row.id):String(row.project_id);await coordination(c.env,ws,qaId(pid),true);
        const ids=[row.coordinator_id,row.updated_by,row.actor_id].filter(x=>x!=null);
        for(const person of ids)if(!await c.env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=?').bind(ws,qaId(person)).first())throw new QaError('qa_backup_reference_unavailable');
        if(table==='qa_project_coordination'&&(!Number.isSafeInteger(row.version)||Number(row.version)<1||!row.updated_by||!row.updated_at))throw new QaError('qa_invalid_backup');
      }
      rows.push({table,row});if(rows.length>5000)throw new QaError('qa_backup_batch_too_large',413);
    }
  }
  // References can target an existing issue or one restored earlier in the same transaction.
  for(const {table,row} of rows){
    if(table==='qa_issues'||table==='qa_project_coordination'||table==='qa_coordination_commands')continue;
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
    if(table==='qa_commands'||table==='qa_attachments'||table==='qa_coordination_commands'){columns.push('restored_by');row.restored_by=auth.member.id;}
    statements.push(c.env.DB.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(col=>row[col] as string|number|null)));
  }
  await c.env.DB.batch(statements);
  return {...report,inserted:pending.length};
}
export async function handleQa(c:C):Promise<Response> {
  try {
    const auth=c.get('auth'),ws=auth.member.workspaceId;
    await requireQaEnabled(c.env,ws);
    const active=await c.env.DB.prepare('SELECT id,is_qa_admin FROM members WHERE workspace_id=? AND id=? AND role=? AND is_active=1').bind(ws,auth.member.id,auth.member.role).first<{id:string;is_qa_admin:number}>();
    if(!active)throw new QaError('qa_forbidden',403);
    if(c.req.query('action')==='upload_part') {
      if(isDemoMember(c.env,auth))throw new QaError(DEMO_BLOCKED_MESSAGE,403);
      return await handleQaStorage(c,'upload_part',{});
    }
    let body:Body;try{body=JSON.parse(new TextDecoder().decode(await qaReadBody(c,10*1024*1024)));}catch(e){if(e instanceof QaError)throw e;throw new QaError('qa_invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new QaError('qa_invalid_request');
    const action=String(body.action??'');
    if(!['list','get','download','get_workflow','get_field_configuration','get_display_settings','versions','get_coordination','my_coordination'].includes(action)&&isDemoMember(c.env,auth))throw new QaError(DEMO_BLOCKED_MESSAGE,403);
    if(action==='versions') {
      const projectId=qaId(body.projectId);
      const project=await c.env.DB.prepare('SELECT id FROM projects WHERE workspace_id=? AND id=?').bind(ws,projectId).first();
      if(!project)throw new QaError('qa_project_unavailable',403);
      // Scope every source to the authenticated tenant and selected project.
      const sources=[];
      for(let offset=0;;offset+=500) {
        const page=await c.env.DB.prepare(`SELECT workspace_id AS workspaceId,project_id AS projectId,
          json_extract(data,'$.observedVersion') AS observedVersion,
          json_extract(data,'$.targets') AS targets,json_extract(data,'$.runs') AS runs
          FROM qa_issues WHERE workspace_id=? AND project_id=? ORDER BY id LIMIT 500 OFFSET ?`)
          .bind(ws,projectId,offset).all<{workspaceId:string;projectId:string;observedVersion:string;targets:string|null;runs:string|null}>();
        sources.push(...page.results.map(row=>({...row,targets:JSON.parse(row.targets||'[]'),runs:JSON.parse(row.runs||'[]')})));
        if(page.results.length<500)break;
        if(sources.length>100000)throw new QaError('qa_too_many_versions',413);
      }
      return c.json(qaVersionSuggestions(sources,ws,projectId));
    }
    if(action==='get_coordination')return c.json(await coordination(c.env,ws,qaId(body.projectId)));
    if(action==='deployment_permission')return c.json({deploymentOperator:await deploymentQueueOperator(c.env,auth)});
    // The projects whose QA the caller coordinates, so cards can offer triage outside the selected project.
    if(action==='my_coordination'){
      const rows=await c.env.DB.prepare('SELECT q.id FROM qa_project_coordination q JOIN projects p ON p.workspace_id=q.workspace_id AND p.id=q.id AND p.is_archived=0 WHERE q.workspace_id=? AND q.coordinator_id=? ORDER BY q.id LIMIT 1000')
        .bind(ws,auth.member.id).all<{id:string}>();
      return c.json({projectIds:rows.results.map(row=>row.id)});
    }
    if(action==='members'){
      await coordination(c.env,ws,qaId(body.projectId));
      const offset=body.offset??0,search=typeof body.search==='string'?body.search.trim():'';
      if(!Number.isSafeInteger(offset)||Number(offset)<0||Number(offset)>100000||search.length>100)throw new QaError('qa_invalid_request');
      const rows=await c.env.DB.prepare('SELECT id,name FROM members WHERE workspace_id=? AND is_active=1 AND instr(lower(name),lower(?))>0 ORDER BY name,id LIMIT 100 OFFSET ?').bind(ws,search,offset as number).all();
      return c.json({members:rows.results,hasMore:rows.results.length===100});
    }
    if(action==='save_coordination'){
      const projectId=qaId(body.projectId),coordinatorId=body.coordinatorId===null?null:qaId(body.coordinatorId),expectedVersion=body.expectedVersion;
      if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<0)throw new QaError('qa_invalid_version');
      if(!['admin','super_admin'].includes(auth.member.role))throw new QaError('qa_forbidden',403);
      const cid=qaId(body.commandId),hash=await qaHash(canonicalQaJson(body)),result={projectId,coordinatorId,version:Number(expectedVersion)+1},now=new Date().toISOString();
      const prior=await c.env.DB.prepare('SELECT actor_id,payload_hash,response FROM qa_coordination_commands WHERE workspace_id=? AND id=?').bind(ws,cid).first<{actor_id:string;payload_hash:string;response:string}>();
      if(prior){if(prior.actor_id!==auth.member.id||prior.payload_hash!==hash)throw new QaError('qa_command_id_reused',409);return c.json(JSON.parse(prior.response));}
      const authId=await commandAuthId(c.env,auth);if(!authId)throw new QaError('qa_forbidden',403);
      try{await c.env.DB.batch([
        c.env.DB.prepare('INSERT INTO qa_coordination_commands(workspace_id,id,project_id,actor_id,actor_auth_id,payload_hash,expected_version,response,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(ws,cid,projectId,auth.member.id,authId,hash,expectedVersion as number,JSON.stringify(result),now),
        c.env.DB.prepare('INSERT INTO qa_project_coordination(workspace_id,id,coordinator_id,version,updated_by,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET coordinator_id=excluded.coordinator_id,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(ws,projectId,coordinatorId,result.version,auth.member.id,now)
      ]);}catch(error){const retry=await c.env.DB.prepare('SELECT actor_id,payload_hash,response FROM qa_coordination_commands WHERE workspace_id=? AND id=?').bind(ws,cid).first<{actor_id:string;payload_hash:string;response:string}>();if(retry&&retry.actor_id===auth.member.id&&retry.payload_hash===hash)return c.json(JSON.parse(retry.response));throw sqlError(error);}
      return c.json(result);
    }
    if(action==='get_display_settings') {
      const live=liveMemberSql(auth,'display_actor',{strict:true});
      const actor=await c.env.DB.prepare(`SELECT display_actor.id FROM members display_actor WHERE ${live.sql}`).bind(...live.params).first();
      if(!actor)throw new QaError('qa_forbidden',403);
      const row=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_display_settings'").bind(ws).first<{value:string}>();
      return c.json(parseQaDisplaySettings(row?.value));
    }
    if(action==='save_display_settings') {
      if(auth.member.role!=='super_admin')throw new QaError('qa_forbidden',403);
      const configuration=validateQaDisplaySettings(body.configuration);
      const previous=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_display_settings'").bind(ws).first<{value:string}>();
      const live=liveMemberSql(auth,'display_actor',{strict:true});
      const result=await c.env.DB.prepare(`INSERT INTO system_settings(workspace_id,key,value,updated_at)
        SELECT ?,'qa_display_settings',?,? WHERE EXISTS(SELECT 1 FROM members display_actor WHERE ${live.sql} AND display_actor.role='super_admin')
        AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=? AND key='feature_toggles' AND json_extract(value,'$.qa')=1)
        AND (SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_display_settings') IS ?
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(ws,JSON.stringify(configuration),new Date().toISOString(),...live.params,ws,ws,previous?.value??null).run();
      if(result.meta.changes!==1)throw new QaError('qa_configuration_conflict',409);
      return c.json(configuration);
    }
    if(action==='get_manual_state_visibility') {
      const row=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_manual_state_visibility'").bind(ws).first<{value:string}>();
      return c.json(parseQaManualStateVisibility(row?.value));
    }
    if(action==='save_manual_state_visibility') {
      if(!canManageQaConfiguration({role:auth.member.role,qaAdmin:active.is_qa_admin===1}))throw new QaError('qa_forbidden',403);
      const configuration=validateQaManualStateVisibility(body.configuration);
      const result=await c.env.DB.prepare(`INSERT INTO system_settings(workspace_id,key,value,updated_at)
        SELECT ?,'qa_manual_state_visibility',?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND (role IN ('admin','super_admin') OR is_qa_admin=1))
        AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=? AND key='feature_toggles' AND json_extract(value,'$.qa')=1)
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(ws,JSON.stringify(configuration),new Date().toISOString(),ws,auth.member.id,ws).run();
      if(result.meta.changes!==1)throw new QaError('qa_forbidden',403);
      return c.json(configuration);
    }
    if(action==='get_workflow') {
      const row=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_workflow'").bind(ws).first<{value:string}>();
      return c.json(parseQaWorkflow(row?.value));
    }
    if(action==='save_workflow') {
      if(!canManageQaConfiguration({role:auth.member.role,qaAdmin:active.is_qa_admin===1}))throw new QaError('qa_forbidden',403);
      const workflow=validateQaWorkflow(body.workflow);
      const result=await c.env.DB.prepare(`INSERT INTO system_settings(workspace_id,key,value,updated_at)
        SELECT ?,'qa_workflow',?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND (role IN ('admin','super_admin') OR is_qa_admin=1))
        AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=? AND key='feature_toggles' AND json_extract(value,'$.qa')=1)
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(ws,JSON.stringify(workflow),new Date().toISOString(),ws,auth.member.id,ws).run();
      if(result.meta.changes!==1)throw new QaError('qa_forbidden',403);
      return c.json(workflow);
    }
    if(action==='get_field_configuration') {
      const row=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields'").bind(ws).first<{value:string}>();
      return c.json(parseQaFieldConfiguration(row?.value));
    }
    if(action==='save_field_configuration') {
      if(!canManageQaConfiguration({role:auth.member.role,qaAdmin:active.is_qa_admin===1}))throw new QaError('qa_forbidden',403);
      const previous=await c.env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields'").bind(ws).first<{value:string}>();
      const configuration=validateQaFieldConfiguration(body.configuration,parseQaFieldConfiguration(previous?.value));
      const result=await c.env.DB.prepare(`INSERT INTO system_settings(workspace_id,key,value,updated_at)
        SELECT ?,'qa_custom_fields',?,? WHERE EXISTS(SELECT 1 FROM members WHERE workspace_id=? AND id=? AND is_active=1 AND (role IN ('admin','super_admin') OR is_qa_admin=1))
        AND EXISTS(SELECT 1 FROM system_settings WHERE workspace_id=? AND key='feature_toggles' AND json_extract(value,'$.qa')=1)
        AND (SELECT value FROM system_settings WHERE workspace_id=? AND key='qa_custom_fields') IS ?
        ON CONFLICT(workspace_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
        .bind(ws,JSON.stringify(configuration),new Date().toISOString(),ws,auth.member.id,ws,ws,previous?.value??null).run();
      if(result.meta.changes!==1)throw new QaError('qa_configuration_conflict',409);
      return c.json(configuration);
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
      const people=[...new Set([issue.assigneeId,issue.qaOwnerId,issue.handoff?.nextOwnerId,issue.handoff?.requestedBy,issue.handoff?.acceptedBy,issue.handoff?.resolvedBy].filter((v):v is string=>!!v))];
      const names=people.length?await c.env.DB.prepare(`SELECT id,name FROM members WHERE workspace_id=? AND id IN (${people.map(()=>'?').join(',')})`).bind(ws,...people).all<{id:string;name:string}>():{results:[]};
      return c.json({issue,memberNames:Object.fromEntries(names.results.map(m=>[m.id,m.name])),coordination:await coordination(c.env,ws,issue.projectId,true),comments:comments.results,events:events.results,attachments:attachments.results.map(qaAttachmentWire)});
    }
    if(action==='delete') {
      const id=qaId(body.id),issue=await getQaIssue(c.env,ws,id);
      if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion!==issue.version)throw new QaError('qa_conflict',409);
      if(!canQaDelete(issue,{id:auth.member.id,role:auth.member.role,qaAdmin:active.is_qa_admin===1}))throw new QaError('qa_forbidden',403);
      return c.json(await deleteIssue(c,issue));
    }
    if(['upload_init','upload_complete','download'].includes(action))return await handleQaStorage(c,action,body);
    if(!['create','command','comment'].includes(action))throw new QaError('qa_invalid_action');
    const id=qaId(body.id),commandId=qaId(body.commandId),hash=await qaHash(canonicalQaJson({...body,actor:auth.member.id}));
    const prior=await receipt(c.env,ws,commandId,hash,auth.member.id);if(prior!==undefined)return c.json(prior);
    if(action==='create') {
      const input=body.input as QaCreateInput;if(!input||typeof input!=='object')throw new QaError('qa_invalid_input');
      const ctx=await context(c.env,auth,qaId(input.projectId),[],undefined,true),issue=createQaIssue(input,id,ctx);
      return c.json(await commit(c,commandId,hash,null,issue,'create',issue,undefined,ctx.fieldConfigurationRaw));
    }
    const before=await getQaIssue(c.env,ws,id);
    if(action==='comment') {
      if(!canQaComment(before,{id:auth.member.id,role:auth.member.role}))throw new QaError('qa_forbidden',403);
      if(typeof body.body!=='string'||!body.body.trim()||body.body.length>20000)throw new QaError('qa_invalid_comment');
      const now=new Date().toISOString(),comment:QaComment={id:crypto.randomUUID(),issueId:id,actorId:auth.member.id,body:body.body.trim(),createdAt:now};
      const after={...before,version:before.version+1,updatedAt:now};
      return c.json(await commit(c,commandId,hash,before,after,'comment',comment,comment));
    }
    if(!Number.isSafeInteger(body.expectedVersion)||body.expectedVersion!==before.version)throw new QaError('qa_conflict',409);
    const command=body.command as QaCommand;if(!command||typeof command.type!=='string')throw new QaError('qa_invalid_command');
    const requestedTasks=command.type==='link_tasks'&&Array.isArray(command.taskIds)?command.taskIds:before.taskIds;
    if(requestedTasks.length>100)throw new QaError('qa_too_many_tasks');requestedTasks.forEach(qaId);
    const destinationId=command.type==='update_fields'?qaId(command.projectId):before.projectId;
    const moving=destinationId!==before.projectId;
    const ctx=await context(c.env,auth,destinationId,moving?before.taskIds:requestedTasks,command.type==='close'?command.duplicateOfId:before.duplicateOfId??undefined,command.type==='edit');
    if(moving){
      const source=await c.env.DB.prepare('SELECT id FROM projects WHERE workspace_id=? AND id=? AND is_archived=0').bind(auth.member.workspaceId,before.projectId).first<{id:string}>();
      if(!source)throw new QaError('qa_project_unavailable');
      ctx.projectIds=new Set([...ctx.projectIds,source.id]);
    }
    const after=applyQaCommand(before,command,ctx);
    return c.json(await commit(c,commandId,hash,before,after,command.type,after,undefined,ctx.fieldConfigurationRaw));
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
