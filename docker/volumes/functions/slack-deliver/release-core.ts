import { DeliveryError, escapeSlack, failureResult, isChannelMember, matchingChannels, slackTransport, type Row } from './core.ts';
export type ReleaseDeliveryJob = { id:string; event_id:string; batch_id:string; workspace_id:string; attempts:number };
export type ReleaseDeliveryState = { batch:Row; event:Row; publication:Row; projects:Row[]; ownerName:string; publisherUser:string; thread?:string };
export interface ReleaseDeliveryStore {
 config():Promise<Row|undefined>; claim(owner:string):Promise<ReleaseDeliveryJob|undefined>; snapshot(job:ReleaseDeliveryJob):Promise<ReleaseDeliveryState|undefined>;
 token():Promise<string|undefined>; canSend(job:ReleaseDeliveryJob,owner:string,state:ReleaseDeliveryState):Promise<boolean>;
 finish(job:ReleaseDeliveryJob,owner:string,result:Row):Promise<boolean>;
}
const labels:Record<string,string>={create:'建立批次',edit_manifest:'更新發布清單',link_evidence:'新增 QA／UAT 紀錄',request_exception:'提出例外',decide_exception:'例外決定',start_attempt:'建立操作紀錄',record_result:'更新部署／回滾／恢復紀錄',record_maintenance:'更新維護紀錄',complete:'批次完成',cancel:'取消批次',publish_thread:'發布討論串'};
const statuses:Record<string,string>={draft:'準備中',active:'進行中',completed:'已完成',cancelled:'已取消'};
export function releaseMessage(state:ReleaseDeliveryState,appBase:string):Row {
 const base=new URL(appBase); if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw new DeliveryError('invalid_app_url');
 const url=`${base.origin}${base.pathname.replace(/\/$/,'')}/?release=${encodeURIComponent(state.batch.id)}`;
 const safe=(value:unknown,max=100)=>escapeSlack(Array.from(String(value??'')).slice(0,max).join(''));
 const batch=state.batch, components=Array.isArray(batch.components)?batch.components:[];
 const lines=[`🚀 *${safe(batch.title,180)}*`,`👤 ${safe(state.ownerName)} | ${statuses[batch.status]||'更新'} | 清單版本 ${safe(batch.manifestRevision)}`,
   `${labels[state.event.operation]||'批次更新'} · 紀錄版本 ${safe(state.event.version)}（目前版本 ${safe(batch.version)}）`];
 const footer='此為摘要，完整清單與紀錄請開啟批次查看。';
 const add=(line:string)=>{if(lines.join('\n').length+line.length+footer.length+2>2700)return false;lines.push(line);return true;};
 summaries: for(const component of components.slice(0,6)){
  const project=state.projects.find(p=>p.id===component.projectId);
  if(!add(`📦 ${safe(component.name)} · ${safe(project?.name)}`))break;
  for(const target of (Array.isArray(component.targets)?component.targets:[]).slice(0,3))if(!add(`  ${safe(target.environment,60)} | Build: ${safe(target.build,60)} | Config: ${safe(target.config,60)} | Data: ${safe(target.data,60)}`))break summaries;
  if(component.targets?.length>3&&!add(`  另 ${component.targets.length-3} 個環境`))break;
 }
 if(components.length>6)add(`另 ${components.length-6} 個元件`);
 lines.push(footer);
 // Notes, QA/UAT bodies, URLs, exception reasons and maintenance impacts are never emitted.
 return {text:lines.join('\n'),unfurl_links:false,unfurl_media:false,blocks:[
  {type:'section',text:{type:'mrkdwn',text:lines.join('\n')}},
  {type:'actions',elements:[{type:'button',text:{type:'plain_text',text:'開啟 LIVO 發布批次'},url}]}
 ]};
}
export function releaseRouteAllowed(config:Row|undefined,state:ReleaseDeliveryState):boolean {
 const pub=state.publication, components=state.batch.components;
 if(config?.enabled!==true||config.teamId!==pub.team_id||!Array.isArray(components)||!components.length||!/^[CG][A-Z0-9]+$/.test(pub.channel_id||''))return false;
 return components.every((c:Row)=>matchingChannels(config,state.projects.find(p=>p.id===c.projectId)).includes(pub.channel_id));
}
export async function deliverRelease(job:ReleaseDeliveryJob,owner:string,store:ReleaseDeliveryStore,appBase:string,fetcher:typeof fetch=fetch):Promise<string>{
 let result:Row,posting=false;
 try{
  const state=await store.snapshot(job),config=await store.config();
  if(!state||!releaseRouteAllowed(config,state))result={status:'skipped',error:'release_route_unavailable'};
  else{
   const token=await store.token();if(!token)throw new DeliveryError('slack_token_unavailable');
   const slack=slackTransport(token,fetcher),auth=await slack('auth.test',{});
   if(auth.team_id!==state.publication.team_id)throw new DeliveryError('slack_workspace_mismatch');
   const publisher=(await slack('users.info',{user:state.publisherUser})).user;
   if(!publisher||publisher.deleted||publisher.is_bot||publisher.is_restricted||publisher.is_ultra_restricted||publisher.team_id!==state.publication.team_id)throw new DeliveryError('publication_member_unavailable');
   if(!/^[UW][A-Z0-9]+$/.test(state.publisherUser)||!auth.user_id||
     !await isChannelMember(slack,state.publication.channel_id,state.publisherUser)||
     !await isChannelMember(slack,state.publication.channel_id,auth.user_id))throw new DeliveryError('publication_member_unavailable');
   const thread=state.thread;
   if(thread&&!/^\d+\.\d+$/.test(thread))throw new DeliveryError('invalid_release_thread');
   const message=releaseMessage(state,appBase);
   if(!await store.canSend(job,owner,state))result={status:'skipped',error:'release_authorization_changed'};
   else{
    posting=true;
    const sent=await slack('chat.postMessage',{channel:state.publication.channel_id,...message,...(thread?{thread_ts:thread}:{}),
      metadata:{event_type:'livo_release',event_payload:{batch_id:job.batch_id,event_id:state.event.id}}});
    if(!/^\d+\.\d+$/.test(sent.ts||''))throw new DeliveryError('missing_slack_receipt',false,true);
    result={status:'sent',messageTs:sent.ts,threadTs:thread||sent.ts};
   }
  }
 }catch(error){
  result=failureResult(error instanceof DeliveryError?error:new DeliveryError(posting?'release_result_unknown':'release_state_unavailable',!posting,posting),job.attempts);
 }
 // A successful Slack post followed by a DB error leaves the lease for manual review.
 if(!await store.finish(job,owner,result))throw new DeliveryError('release_delivery_lease_lost',false,true);
 return result.status;
}
