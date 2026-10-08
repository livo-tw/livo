import { applyReleaseCommand, canonicalReleaseJson, parseReleaseRequest, ReleaseError, RELEASE_ERROR_STATUS, releaseReferenceIds,
  type ReleaseBatch, type ReleaseContext, type ReleaseEvent, type ReleaseQaSource, type ReleaseRequest, type ReleaseResult } from './core.ts';
import { memberEmailIdentityVerified } from '../slack-notify/core.ts';
import { parseDeploymentEnvironments } from './environments.ts';
export interface ReleaseEnvironment { get(name:string):string|undefined }
type Row=Record<string,any>;
/** Signed Slack identity is accepted only after GoTrue verifies this exact JWT. */
function slackClaims(token:string,authId:string) {
  try { const part=token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
    const c=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(Math.ceil(part.length/4)*4,'=')),x=>x.charCodeAt(0))));
    if(c.sub!==authId)throw new Error(); if(!Object.keys(c).some(k=>k.startsWith('livo_slack_')))return null;
    if(!['livo_slack_binding','livo_slack_team','livo_slack_user'].every(k=>typeof c[k]==='string')||!/^[\w-]{1,128}$/.test(c.livo_slack_binding)||!/^T[A-Z0-9]+$/.test(c.livo_slack_team)||! /^[UW][A-Z0-9]+$/.test(c.livo_slack_user))throw new Error();
    return {bindingId:c.livo_slack_binding,teamId:c.livo_slack_team,userId:c.livo_slack_user};
  }catch{throw new ReleaseError('release_unauthorized',401);}
}
export function createReleaseService(env:ReleaseEnvironment,token:string,fetcher:typeof fetch=fetch){
  const base=env.get('SUPABASE_URL')?.replace(/\/$/,''),anon=env.get('SUPABASE_ANON_KEY'),service=env.get('SUPABASE_SERVICE_ROLE_KEY');
  const request=async(path:string,query:Row={},body?:unknown,privileged=false):Promise<any>=>{
    const response=await fetcher(`${base}${path}${Object.keys(query).length?'?'+new URLSearchParams(query):''}`,{method:body===undefined?'GET':'POST',headers:{apikey:anon||'',Authorization:`Bearer ${privileged?service:token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    const data=await response.json().catch(():null=>null);if(!response.ok){const code=path==='/auth/v1/user'&&[401,403].includes(response.status)?'release_unauthorized':typeof data?.message==='string'&&Object.prototype.hasOwnProperty.call(RELEASE_ERROR_STATUS,data.message)?data.message:'release_unavailable';throw new ReleaseError(code,RELEASE_ERROR_STATUS[code]);}return data;
  };
  const rows=(table:string,query:Row={})=>request(`/rest/v1/${table}`,query) as Promise<Row[]>;
  const actor=async()=>{
    if(!base||!anon||!service)throw new ReleaseError('release_unavailable',503);
    if(!token||token===anon||token===service)throw new ReleaseError('release_unauthorized',401);
    const user=await request('/auth/v1/user');if(typeof user?.id!=='string'||!/^[0-9a-f-]{36}$/i.test(user.id))throw new ReleaseError('release_unauthorized',401);
    const candidates=await rows('members',{select:'id,role,is_active,auth_id,email_identity_verified',auth_id:`eq.${user.id}`,is_active:'eq.true',limit:2});
    if(candidates.length!==1)throw new ReleaseError('release_forbidden',403);
    const identity=slackClaims(token,user.id);
    if(identity){const features=await rows('system_settings',{select:'value',key:'eq.feature_toggles',limit:1});if(features[0]?.value?.slackActions!==true)throw new ReleaseError('release_forbidden',403);const bindings=await rows('external_account_bindings',{select:'id,verified_by,verified_by_member_id,reconfirm_required',id:`eq.${identity.bindingId}`,member_id:`eq.${candidates[0].id}`,platform:'eq.slack',platform_team_id:`eq.${identity.teamId}`,platform_user_id:`eq.${identity.userId}`,is_verified:'eq.true',limit:1});if(bindings.length!==1||bindings[0].reconfirm_required===true||!['email','admin'].includes(bindings[0].verified_by))throw new ReleaseError('release_forbidden',403);if(bindings[0].verified_by==='email'&&!memberEmailIdentityVerified(candidates[0]))throw new ReleaseError('release_forbidden',403);if(bindings[0].verified_by==='admin'){const issuers=await rows('members',{select:'id',id:`eq.${bindings[0].verified_by_member_id}`,role:'eq.super_admin',is_active:'eq.true',limit:1});if(issuers.length!==1)throw new ReleaseError('release_forbidden',403);}}
    return {id:String(candidates[0].id),role:String(candidates[0].role),authId:user.id as string,identity};
  };
  const get=async(id:string):Promise<ReleaseBatch>=>{const list=await rows('release_batches',{select:'data',id:`eq.${id}`,limit:1});if(!list[0])throw new ReleaseError('release_not_found',404);return list[0].data;};
  return { async handle(input:unknown):Promise<unknown>{
    const p:ReleaseRequest=parseReleaseRequest(input),a=await actor();
    if(p.action==='get')return get(p.batchId);
    if(p.action==='receipt'){
      if(!['admin','super_admin'].includes(a.role))throw new ReleaseError('release_forbidden',403);
      const rows=await request('/rest/v1/release_commands',{select:'actor_id,request_hash,command,result_json,batch_id',id:`eq.${p.commandId}`,limit:1},undefined,true),r=rows[0];
      if(!r)return {found:false};if(r.actor_id!==a.id||r.batch_id!==p.batchId)throw new ReleaseError('release_forbidden',403);
      const result=await request('/rest/v1/rpc/livo_release_commit',{}, {p_auth_id:a.authId,p_command:r.command,p_hash:r.request_hash,p_after:r.result_json.batch,p_event:r.result_json.event,p_slack_identity:a.identity},true);
      return {found:true,result:{...result,replayed:true,batch:await get(p.batchId)}};
    }
    if(p.action==='events'){await get(p.batchId);const result=await rows('release_events',{select:'*',batch_id:`eq.${p.batchId}`,order:'version.desc',offset:p.page*8,limit:9});return {events:result.slice(0,8).map(r=>({id:r.id,batchId:r.batch_id,actorId:r.actor_id,operation:r.operation,version:r.version,revision:r.revision,createdAt:r.created_at})),page:p.page,hasMore:result.length>8};}
    if(p.action==='list'){
      const query:Row={select:'data',order:'updated_at.desc,id',offset:p.page*8,limit:9};if(p.search)query.title=`ilike.*${p.search.replace(/[*,()]/g,'')}*`;
      if(p.projectId){query.select='data,release_batch_projects!inner(project_id)';query['release_batch_projects.project_id']=`eq.${p.projectId}`;}
      const result=await rows('release_batches',query);return {batches:result.slice(0,8).map(r=>r.data),page:p.page,hasMore:result.length>8};
    }
    if(!['admin','super_admin'].includes(a.role))throw new ReleaseError('release_forbidden',403);
    const command=p.command,hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalReleaseJson(command))))].map(x=>x.toString(16).padStart(2,'0')).join('');
    // Receipts are service-only; read permission and actor are rechecked before replaying any private body.
    const prior=await request('/rest/v1/release_commands',{select:'actor_id,request_hash,command,result_json',id:`eq.${command.commandId}`,limit:1},undefined,true);
    if(prior[0]){if(prior[0].actor_id!==a.id||prior[0].request_hash!==hash||canonicalReleaseJson(prior[0].command)!==canonicalReleaseJson(command))throw new ReleaseError('release_command_reused',409);const result=await request('/rest/v1/rpc/livo_release_commit',{}, {p_auth_id:a.authId,p_command:command,p_hash:hash,p_after:prior[0].result_json.batch,p_event:prior[0].result_json.event,p_slack_identity:a.identity},true);return {...result,replayed:true,batch:await get(command.batchId)};}
    const before=command.operation==='create'?null:await get(command.batchId),manifest='manifest'in command?command.manifest:before!,refs=releaseReferenceIds(manifest);
    const [members,projects,tasks,settings,issues]=await Promise.all([
      rows('members',{select:'id',id:`eq.${manifest.ownerId}`,is_active:'eq.true'}),rows('projects',{select:'id',id:`in.(${refs.projectIds.join(',')})`,is_archived:'eq.false'}),
      refs.taskIds.length?rows('tasks',{select:'id,project_id',id:`in.(${refs.taskIds.join(',')})`}):[],rows('system_settings',{select:'value',key:'eq.deployment_environments',limit:1}),
      // QA tables are service-only (20261002_qa_workflow.sql); the actor is already a checked admin.
      command.operation==='link_evidence'&&command.kind==='qa'?request('/rest/v1/qa_issues',{select:'data',id:`eq.${command.issueId}`,limit:1},undefined,true) as Promise<Row[]>:[],
    ]);
    const environments=parseDeploymentEnvironments(settings[0]?.value);if(!environments&&['create','edit_manifest','link_evidence','start_attempt'].includes(command.operation))throw new ReleaseError('release_invalid_environment');
    const ctx:ReleaseContext={workspaceId:'default',actorId:a.id,role:a.role,now:new Date().toISOString(),newId:()=>crypto.randomUUID(),memberIds:new Set(members.map(r=>r.id)),projectIds:new Set(projects.map(r=>r.id)),taskProjects:new Map(tasks.map(r=>[r.id,r.project_id])),environments:environments?.values??[],qaSources:new Map(issues.map(r=>[r.data.id,r.data as ReleaseQaSource])),...(a.identity?{slackIdentity:a.identity}:{})};
    const batch=applyReleaseCommand(before,command,ctx),event:ReleaseEvent={id:ctx.newId(),batchId:batch.id,actorId:a.id,operation:command.operation,version:batch.version,revision:batch.manifestRevision,createdAt:ctx.now};
    return await request('/rest/v1/rpc/livo_release_commit',{}, {p_auth_id:a.authId,p_command:command,p_hash:hash,p_after:batch,p_event:event,p_slack_identity:a.identity},true) as ReleaseResult;
  }};
}
