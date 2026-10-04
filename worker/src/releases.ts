import type { Context } from 'hono';
import type { AppContext, AuthCtx, Env } from './env';
import { sha256Hex } from './auth';
import { liveMemberSql } from './liveMember';
import { qaReadBody } from './qa';
import { parseDeploymentEnvironments } from './qa/environments';
import { applyReleaseCommand, canonicalReleaseJson, parseReleaseRequest, releaseError, ReleaseError, releaseReferenceIds,
  type ReleaseBatch, type ReleaseCommand, type ReleaseContext, type ReleaseEvent, type ReleaseQaSource, type ReleaseResult } from './releases/core';
type C = Context<AppContext>;
async function actor(env: Env, auth: AuthCtx, write = false) {
  const live = liveMemberSql(auth, 'm', { strict: true });
  const row = await env.DB.prepare(`SELECT m.role,m.auth_id FROM members m WHERE ${live.sql}`).bind(...live.params).first<{role:string;auth_id:string|null}>();
  if (!row || (write && !['admin','super_admin'].includes(row.role))) throw new ReleaseError('release_forbidden',403);
  return row;
}
async function read(env: Env, auth: AuthCtx, id: string): Promise<ReleaseBatch> {
  await actor(env,auth);
  const row = await env.DB.prepare(`SELECT b.data FROM release_batches b WHERE b.workspace_id=? AND b.id=?
    AND NOT EXISTS(SELECT 1 FROM release_batch_projects r LEFT JOIN projects p ON p.workspace_id=r.workspace_id AND p.id=r.project_id WHERE r.workspace_id=b.workspace_id AND r.batch_id=b.id AND p.id IS NULL)
    AND NOT EXISTS(SELECT 1 FROM release_batch_tasks r LEFT JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id WHERE r.workspace_id=b.workspace_id AND r.batch_id=b.id AND t.id IS NULL)`).bind(auth.member.workspaceId,id).first<{data:string}>();
  if (!row) throw new ReleaseError('release_not_found',404);
  return JSON.parse(row.data) as ReleaseBatch;
}
async function context(env: Env, auth: AuthCtx, command: ReleaseCommand, before: ReleaseBatch | null): Promise<ReleaseContext> {
  const live=await actor(env,auth,true), manifest='manifest' in command?command.manifest:before!;
  const refs=releaseReferenceIds(manifest), ws=auth.member.workspaceId;
  const [members,projects,tasks,settings,qa] = await Promise.all([
    env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=? AND is_active=1').bind(ws,manifest.ownerId).all<{id:string}>(),
    env.DB.prepare(`SELECT id FROM projects WHERE workspace_id=? AND is_archived=0 AND id IN (${refs.projectIds.map(()=>'?').join(',')})`).bind(ws,...refs.projectIds).all<{id:string}>(),
    refs.taskIds.length?env.DB.prepare(`SELECT id,project_id FROM tasks WHERE workspace_id=? AND id IN (${refs.taskIds.map(()=>'?').join(',')})`).bind(ws,...refs.taskIds).all<{id:string;project_id:string}>():{results:[]},
    env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='deployment_environments'").bind(ws).first<{value:string}>(),
    command.operation==='link_evidence'&&command.kind==='qa'?env.DB.prepare('SELECT data FROM qa_issues WHERE workspace_id=? AND id=?').bind(ws,command.issueId!).first<{data:string}>():null,
  ]);
  const environments=parseDeploymentEnvironments(settings?JSON.parse(settings.value):undefined);
  if(!environments&&['create','edit_manifest','link_evidence','start_attempt'].includes(command.operation))throw new ReleaseError('release_invalid_environment');
  const qaSources=new Map<string,ReleaseQaSource>(); if(qa){const issue=JSON.parse(qa.data) as ReleaseQaSource;qaSources.set(issue.id,issue);}
  return {workspaceId:ws,actorId:auth.member.id,role:live.role,now:new Date().toISOString(),newId:()=>crypto.randomUUID(),
    memberIds:new Set(members.results.map(r=>r.id)),projectIds:new Set(projects.results.map(r=>r.id)),taskProjects:new Map(tasks.results.map(r=>[r.id,r.project_id])),environments:environments?.values??[],qaSources};
}
export async function executeReleaseCommand(env:Env,auth:AuthCtx,command:ReleaseCommand):Promise<ReleaseResult>{
  // The command trigger re-checks the actor's login: a key records its member's login.
  const authId=(await actor(env,auth,true)).auth_id;if(!authId)throw new ReleaseError('release_forbidden',403);
  const ws=auth.member.workspaceId, canonical=canonicalReleaseJson(command),hash=await sha256Hex(canonical);
  const receipt=()=>env.DB.prepare('SELECT actor_id,command,request_hash,result_json FROM release_commands WHERE workspace_id=? AND id=?').bind(ws,command.commandId).first<{actor_id:string;command:string;request_hash:string;result_json:string}>();
  const replay=async(prior:NonNullable<Awaited<ReturnType<typeof receipt>>>):Promise<ReleaseResult>=>{
    await actor(env,auth,true);
    if(prior.actor_id!==auth.member.id||prior.command!==canonical||prior.request_hash!==hash)throw new ReleaseError('release_command_reused',409);
    return {...JSON.parse(prior.result_json),replayed:true,batch:await read(env,auth,command.batchId)};
  };
  const previous=await receipt();if(previous)return replay(previous);
  const before=command.operation==='create'?null:await read(env,auth,command.batchId),ctx=await context(env,auth,command,before);
  const batch=applyReleaseCommand(before,command,ctx),event:ReleaseEvent={id:ctx.newId(),batchId:batch.id,actorId:ctx.actorId,operation:command.operation,version:batch.version,revision:batch.manifestRevision,createdAt:ctx.now};
  const result:ReleaseResult={commandId:command.commandId,replayed:false,batch,event};
  try {await env.DB.prepare(`INSERT INTO release_commands(workspace_id,id,batch_id,actor_id,auth_id,expected_version,operation,request_hash,command,data,event_id,result_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(ws,command.commandId,batch.id,ctx.actorId,authId,command.expectedVersion,command.operation,hash,canonical,JSON.stringify(batch),event.id,JSON.stringify(result),ctx.now).run();}
  catch(error){const raced=await receipt();if(raced)return replay(raced);throw releaseError(error);}
  return result;
}
export async function handleReleaseWorkspace(c:C):Promise<Response>{
  try {
    const request=parseReleaseRequest(JSON.parse(new TextDecoder().decode(await qaReadBody(c,262144)))),auth=c.get('auth'),ws=auth.member.workspaceId;
    await actor(c.env,auth);
    if(request.action==='command')return c.json(await executeReleaseCommand(c.env,auth,request.command));
    if(request.action==='get')return c.json(await read(c.env,auth,request.batchId));
    if(request.action==='receipt'){
      await actor(c.env,auth,true);const r=await c.env.DB.prepare('SELECT actor_id,batch_id,result_json FROM release_commands WHERE workspace_id=? AND id=?').bind(ws,request.commandId).first<{actor_id:string;batch_id:string;result_json:string}>();
      if(!r)return c.json({found:false});if(r.actor_id!==auth.member.id||r.batch_id!==request.batchId)throw new ReleaseError('release_forbidden',403);
      await actor(c.env,auth,true);return c.json({found:true,result:{...JSON.parse(r.result_json),replayed:true,batch:await read(c.env,auth,request.batchId)}});
    }
    if(request.action==='events'){
      await read(c.env,auth,request.batchId);
      const rows=await c.env.DB.prepare('SELECT id,batch_id,actor_id,operation,version,revision,created_at FROM release_events WHERE workspace_id=? AND batch_id=? ORDER BY version DESC LIMIT 9 OFFSET ?').bind(ws,request.batchId,request.page*8).all<{id:string;batch_id:string;actor_id:string;operation:ReleaseEvent['operation'];version:number;revision:number;created_at:string}>();
      return c.json({events:rows.results.slice(0,8).map(r=>({id:r.id,batchId:r.batch_id,actorId:r.actor_id,operation:r.operation,version:r.version,revision:r.revision,createdAt:r.created_at})),page:request.page,hasMore:rows.results.length>8});
    }
    const clauses=['b.workspace_id=?'],args:(string|number)[]=[ws];
    if(request.projectId){clauses.push('EXISTS(SELECT 1 FROM release_batch_projects r WHERE r.workspace_id=b.workspace_id AND r.batch_id=b.id AND r.project_id=?)');args.push(request.projectId);}
    if(request.search){clauses.push("b.title LIKE ? ESCAPE '\\'");args.push(`%${request.search.replace(/[\\%_]/g,'\\$&')}%`);}
    const rows=await c.env.DB.prepare(`SELECT b.id FROM release_batches b WHERE ${clauses.join(' AND ')} ORDER BY b.updated_at DESC,b.id LIMIT 9 OFFSET ?`).bind(...args,request.page*8).all<{id:string}>();
    const batches:ReleaseBatch[]=[];for(const row of rows.results.slice(0,8))batches.push(await read(c.env,auth,row.id));
    return c.json({batches,page:request.page,hasMore:rows.results.length>8});
  }catch(error){const e=error instanceof SyntaxError?new ReleaseError('release_invalid_input'):releaseError(error);return c.json({error:e.code},e.status as 400);}
}
