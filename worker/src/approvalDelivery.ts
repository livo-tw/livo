import { appBaseUrl, type Env } from './env';
import { approvalsEnabled } from './featureToggles';
import { checkProfessional } from './license';
import { resolveSlackToken } from './functions/slack';
import { canActOnApproval, type ApprovalRequestState } from './approval/core';

type Row = Record<string, any>;
export interface ApprovalDeliveryJob {
  workspace_id:string;id:string;task_id:string;request_id:string;event_id:string;recipient_id:string|null;
  team_id:string;target_id:string;delivery_type:'channel'|'dm';operation:string;request_version:number;attempts:number;lease_token:string;
}
class DeliveryError extends Error {
  constructor(public code:string,public uncertain=false,public retryAfter=0){super(code);}
}
const safe=(value:unknown,limit=240)=>String(value??'').slice(0,limit).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
export function approvalTaskUrl(base:string,key:string):string {
  const url=new URL(base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new DeliveryError('invalid_app_url');
  return `${url.origin}${url.pathname.replace(/\/$/,'')}/?task=${encodeURIComponent(key)}`;
}
export function approvalThread(ts:string|undefined,now=Date.now()):string|undefined {
  if(!ts||!/^\d+\.\d+$/.test(ts))return undefined;const age=now-Number(ts)*1000;
  return age>=0&&age<3600000?ts:undefined;
}
export function approvalDeliveryMessage(job:ApprovalDeliveryJob,task:Row,request:ApprovalRequestState,base:string) {
  const url=approvalTaskUrl(base,task.task_key), labels:Row={submit:'等待簽核',approve:request.status==='pending'?'等待下一階簽核':'簽核通過',reject:'簽核拒絕',return:'簽核退回'};
  const title=labels[job.operation]||'簽核更新',text=`${safe(title)} · ${safe(task.task_key)} ${safe(task.title)}`;
  return {text,blocks:[{type:'section',text:{type:'mrkdwn',text:`📝 *${safe(title)}*\n<${url}|${safe(task.task_key)} ${safe(task.title)}>\n${safe(task.from_name)} → ${safe(task.to_name)}${request.status==='pending'?`\n簽核階段：${request.current_step} / ${request.steps_snapshot?.length??1}`:''}`}},
    {type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'開啟 LIVO 簽核'},url}]}],unfurl_links:false,unfurl_media:false};
}
function transport(token:string,fetcher:typeof fetch) {
  return async(method:string,body:Row):Promise<Row>=>{
    let response:Response;
    try{response=await fetcher(`https://slack.com/api/${method}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});}
    catch{throw new DeliveryError('transport_unavailable',method==='chat.postMessage');}
    if(response.status===429)throw new DeliveryError('rate_limited',false,Math.min(3600,Math.max(1,Number(response.headers.get('retry-after'))||60)));
    let result:Row;try{result=await response.json() as Row;}catch{throw new DeliveryError('invalid_response',method==='chat.postMessage');}
    if(!response.ok||!result.ok)throw new DeliveryError('slack_unavailable',method==='chat.postMessage'&&response.status>=500);
    return result;
  };
}
async function configuration(env:Env,ws:string):Promise<Row|undefined>{
  const row=await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='slack_delivery'").bind(ws).first<{value:string}>();
  try{const config=JSON.parse(row?.value||'null');return config&&config.enabled===true&&/^T[A-Z0-9]+$/.test(config.teamId)?config:undefined;}catch{return undefined;}
}
function hasProjectRoute(config:Row,project:Row,channel?:string):boolean{
  return Array.isArray(config.routes)&&config.routes.some((r:Row)=>r&&(r.enabled===undefined||r.enabled===true)
    &&typeof r.channelId==='string'&&/^[CG][A-Z0-9]+$/.test(r.channelId)&&(!channel||r.channelId===channel)
    &&(typeof r.projectId==='string'&&r.projectId.length>0&&r.projectId===project.project_id
      ||typeof r.lineId==='string'&&r.lineId.length>0&&r.lineId===project.line_id));
}
async function finish(env:Env,job:ApprovalDeliveryJob,state:string,extra:{error?:string;delay?:number;channel?:string;ts?:string;root?:string}={}){
  const now=new Date().toISOString(),statements=[env.DB.prepare(`UPDATE approval_delivery_outbox SET state=?,last_error=?,next_attempt_at=?,delivered_ts=?,
    delivered_at=?,lease_token=NULL,lease_expires_at=NULL WHERE workspace_id=? AND id=? AND state='sending' AND lease_token=?`)
    .bind(state,extra.error||null,new Date(Date.now()+(extra.delay||0)*1000).toISOString(),extra.ts||null,state==='sent'?now:null,job.workspace_id,job.id,job.lease_token)];
  if(state==='sent'&&extra.channel&&extra.root) statements.unshift(env.DB.prepare(`INSERT INTO approval_delivery_threads(workspace_id,team_id,task_id,channel_id,thread_ts,created_at)
    SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM approval_delivery_outbox WHERE workspace_id=? AND id=? AND state='sending' AND lease_token=?)
    ON CONFLICT(workspace_id,team_id,task_id,channel_id) DO UPDATE SET thread_ts=excluded.thread_ts,created_at=excluded.created_at`)
    .bind(job.workspace_id,job.team_id,job.task_id,extra.channel,extra.root,now,job.workspace_id,job.id,job.lease_token));
  await env.DB.batch(statements);
}
export async function deliverApprovalJob(env:Env,job:ApprovalDeliveryJob,fetcher:typeof fetch=fetch):Promise<string>{
  try{
    const config=await configuration(env,job.workspace_id);
    if(!config||config.teamId!==job.team_id||!await approvalsEnabled(env,job.workspace_id)||!await checkProfessional(env,job.workspace_id)){
      await finish(env,job,'skipped',{error:'delivery_disabled'});return 'skipped';
    }
    const task=await env.DB.prepare(`SELECT t.*,p.line_id,p.is_archived,sf.name AS from_name,st.name AS to_name FROM tasks t
      JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id
      JOIN approval_requests r ON r.workspace_id=t.workspace_id AND r.id=? AND r.task_id=t.id
      LEFT JOIN statuses sf ON sf.workspace_id=r.workspace_id AND sf.id=r.from_status LEFT JOIN statuses st ON st.workspace_id=r.workspace_id AND st.id=r.to_status
      WHERE t.workspace_id=? AND t.id=?`).bind(job.request_id,job.workspace_id,job.task_id).first<Row>();
    const raw=await env.DB.prepare('SELECT * FROM approval_requests WHERE workspace_id=? AND id=?').bind(job.workspace_id,job.request_id).first<Row>();
    if(!task||task.is_archived||!raw){await finish(env,job,'skipped',{error:'task_unavailable'});return 'skipped';}
    const request={...raw,steps_snapshot:raw.steps_snapshot?JSON.parse(raw.steps_snapshot):null} as ApprovalRequestState;
    // A superseded approval notice is stale. Retry must never alert a former step approver.
    if(request.version!==job.request_version){await finish(env,job,'skipped',{error:'approval_superseded'});return 'skipped';}
    const token=await resolveSlackToken(env,job.workspace_id);if(!token)throw new DeliveryError('slack_not_configured');
    const slack=transport(token,fetcher),auth=await slack('auth.test',{});if(auth.team_id!==job.team_id)throw new DeliveryError('workspace_mismatch');
    let channel=job.target_id,verifiedUser:string|undefined;
    if(job.delivery_type==='channel'){
      const allowed=hasProjectRoute(config,task,channel);
      if(!allowed||!/^[CG][A-Z0-9]+$/.test(channel)){await finish(env,job,'skipped',{error:'route_changed'});return 'skipped';}
    }else{
      if(!hasProjectRoute(config,task)){await finish(env,job,'skipped',{error:'route_changed'});return 'skipped';}
      if(config.dmEnabled!==true||(Object.hasOwn(config,'dmMemberIds')&&(!Array.isArray(config.dmMemberIds)||!config.dmMemberIds.includes(job.recipient_id)))){
        await finish(env,job,'skipped',{error:'dm_disabled'});return 'skipped';}
      const member=await env.DB.prepare('SELECT id,role,is_active FROM members WHERE workspace_id=? AND id=?').bind(job.workspace_id,job.recipient_id).first<Row>();
      if(!member?.is_active||(request.status==='pending'?!canActOnApproval(request,{id:member.id,role:member.role,active:true}):request.requested_by!==member.id)){
        await finish(env,job,'skipped',{error:'recipient_changed'});return 'skipped';}
      const bindings=await env.DB.prepare("SELECT platform_user_id FROM external_account_bindings WHERE workspace_id=? AND member_id=? AND platform='slack' AND platform_team_id=? AND is_verified=1 AND verified_by IN ('email','admin') LIMIT 2")
        .bind(job.workspace_id,job.recipient_id,job.team_id).all<{platform_user_id:string}>();
      if(bindings.results.length!==1||!/^U[A-Z0-9]+$/.test(bindings.results[0].platform_user_id))throw new DeliveryError('verified_binding_unavailable');
      const user=bindings.results[0].platform_user_id,info=await slack('users.info',{user});verifiedUser=user;
      if(!info.user||info.user.id!==user||info.user.deleted||info.user.is_bot||info.user.team_id&&info.user.team_id!==job.team_id)throw new DeliveryError('recipient_unavailable');
      const dm=await slack('conversations.open',{users:user});channel=String(dm.channel?.id||'');if(!/^D[A-Z0-9]+$/.test(channel))throw new DeliveryError('dm_unavailable');
    }
    const currentConfig=await configuration(env,job.workspace_id);
    if(!currentConfig||currentConfig.teamId!==job.team_id||!await approvalsEnabled(env,job.workspace_id)){
      await finish(env,job,'skipped',{error:'delivery_disabled'});return 'skipped';}
    const latest=await env.DB.prepare(`SELECT r.version,r.status,r.current_step,r.requested_by,r.rule_id,r.steps_snapshot,
      t.project_id,p.line_id,p.is_archived FROM approval_requests r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id
      JOIN projects p ON p.workspace_id=t.workspace_id AND p.id=t.project_id WHERE r.workspace_id=? AND r.id=?`)
      .bind(job.workspace_id,job.request_id).first<Row>();
    if(!latest||latest.is_archived||latest.version!==job.request_version){await finish(env,job,'skipped',{error:'approval_superseded'});return 'skipped';}
    if(job.delivery_type==='channel'){
      if(!hasProjectRoute(currentConfig,latest,channel)){
        await finish(env,job,'skipped',{error:'route_changed'});return 'skipped';}
    }else{
      if(!hasProjectRoute(currentConfig,latest)){await finish(env,job,'skipped',{error:'route_changed'});return 'skipped';}
      const live=await env.DB.prepare('SELECT id,role,is_active FROM members WHERE workspace_id=? AND id=?').bind(job.workspace_id,job.recipient_id).first<Row>();
      const liveRequest={...latest,steps_snapshot:latest.steps_snapshot?JSON.parse(latest.steps_snapshot):null} as ApprovalRequestState;
      if(currentConfig.dmEnabled!==true||(Object.hasOwn(currentConfig,'dmMemberIds')&&(!Array.isArray(currentConfig.dmMemberIds)||!currentConfig.dmMemberIds.includes(job.recipient_id)))
        ||!live?.is_active||(latest.status==='pending'?!canActOnApproval(liveRequest,{id:live.id,role:live.role,active:true}):latest.requested_by!==live.id)){
        await finish(env,job,'skipped',{error:'recipient_changed'});return 'skipped';}
      const bindings=await env.DB.prepare("SELECT platform_user_id FROM external_account_bindings WHERE workspace_id=? AND member_id=? AND platform='slack' AND platform_team_id=? AND is_verified=1 AND verified_by IN ('email','admin') LIMIT 2")
        .bind(job.workspace_id,job.recipient_id,job.team_id).all<{platform_user_id:string}>();
      if(bindings.results.length!==1||bindings.results[0].platform_user_id!==verifiedUser){
        await finish(env,job,'skipped',{error:'binding_changed'});return 'skipped';}
    }
    const lease=await env.DB.prepare("SELECT id FROM approval_delivery_outbox WHERE workspace_id=? AND id=? AND state='sending' AND lease_token=? AND lease_expires_at>?")
      .bind(job.workspace_id,job.id,job.lease_token,new Date().toISOString()).first();
    if(!lease)throw new DeliveryError('lease_expired');
    const stored=await env.DB.prepare('SELECT thread_ts FROM approval_delivery_threads WHERE workspace_id=? AND team_id=? AND task_id=? AND channel_id=?').bind(job.workspace_id,job.team_id,job.task_id,channel).first<{thread_ts:string}>();
    const thread=job.delivery_type==='channel'?approvalThread(stored?.thread_ts):undefined;
    const response=await slack('chat.postMessage',{channel,...approvalDeliveryMessage(job,task,request,appBaseUrl(env)),client_msg_id:job.event_id,...(thread?{thread_ts:thread}: {})});
    if(typeof response.ts!=='string'||!/^\d+\.\d+$/.test(response.ts))throw new DeliveryError('delivery_result_unknown',true);
    await finish(env,job,'sent',{channel,ts:response.ts,root:job.delivery_type==='channel'?thread||response.ts:undefined});return 'sent';
  }catch(error){
    const e=error instanceof DeliveryError?error:new DeliveryError('delivery_result_unknown',true),state=e.uncertain?'review':job.attempts>=8?'failed':'pending';
    await finish(env,job,state,{error:e.code,delay:Math.max(e.retryAfter,Math.min(3600,60*2**Math.max(0,job.attempts-1)))});return state;
  }
}
/** Persistent retry entry point used by both committed commands and cron. An
 * expired send lease is ambiguous and requires review, never blind re-posting. */
export async function runApprovalDeliveries(env:Env,workspaceId?:string,fetcher:typeof fetch=fetch):Promise<void>{
  const now=new Date().toISOString();
  await env.DB.prepare("UPDATE approval_delivery_outbox SET state='review',last_error='expired_delivery_lease',lease_token=NULL,lease_expires_at=NULL WHERE state='sending' AND lease_expires_at<=?").bind(now).run();
  const until=Date.now()+35000;
  for(let i=0;i<10&&Date.now()<until;i++){
    const lease=crypto.randomUUID(),time=new Date().toISOString(),expires=new Date(Date.now()+90000).toISOString();
    const job=await env.DB.prepare(`UPDATE approval_delivery_outbox SET state='sending',attempts=attempts+1,lease_token=?,lease_expires_at=?
      WHERE (workspace_id,id)=(SELECT workspace_id,id FROM approval_delivery_outbox q WHERE state='pending' AND next_attempt_at<=? ${workspaceId?'AND workspace_id=?':''}
        AND NOT EXISTS(SELECT 1 FROM approval_delivery_outbox busy WHERE busy.workspace_id=q.workspace_id AND busy.state='sending')
        ORDER BY created_at,id LIMIT 1) RETURNING *`).bind(lease,expires,time,...(workspaceId?[workspaceId]:[])).first<ApprovalDeliveryJob>();
    if(!job)break;await deliverApprovalJob(env,job,fetcher);
  }
}
