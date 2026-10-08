import { Database,trustedAdminBinding,type Environment } from '../slack-interact/backend.ts';
import { memberEmailIdentityVerified } from '../slack-notify/core.ts';
import { deliverRelease,type ReleaseDeliveryStore } from './release-core.ts';
import type { Row } from './core.ts';
export function releaseDeliveryStore(env:Environment):ReleaseDeliveryStore {
 const db=new Database(env);
 return{
  config:()=>db.setting('slack_delivery'),
  claim:async owner=>(await db.request('/rest/v1/rpc/livo_release_claim_delivery','POST',{p_owner:owner}))[0],
  token:async()=>(await db.rows('slack_config',{select:'bot_token',id:'eq.singleton',limit:'1'}))[0]?.bot_token||env.get('SLACK_BOT_TOKEN'),
  snapshot:async job=>{
   const publication=(await db.rows('release_publications',{select:'*',workspace_id:`eq.${job.workspace_id}`,batch_id:`eq.${job.batch_id}`,limit:'1'}))[0];
   if(!publication)return undefined;
   const [batches,events,bindings,links,publishers]=await Promise.all([
    db.rows('release_batches',{select:'data',workspace_id:`eq.${job.workspace_id}`,id:`eq.${job.batch_id}`,limit:'1'}),
    db.rows('release_events',{select:'id,operation,version,revision',workspace_id:`eq.${job.workspace_id}`,id:`eq.${job.event_id}`,limit:'1'}),
    db.rows('external_account_bindings',{select:'platform_user_id,is_verified,verified_by,verified_by_member_id,reconfirm_required',id:`eq.${publication.binding_id}`,member_id:`eq.${publication.published_by}`,platform:'eq.slack',platform_team_id:`eq.${publication.team_id}`,is_verified:'eq.true',verified_by:'in.(email,admin)',limit:'1'}),
    db.rows('release_slack_links',{select:'thread_ts',workspace_id:`eq.${job.workspace_id}`,batch_id:`eq.${job.batch_id}`,team_id:`eq.${publication.team_id}`,channel_id:`eq.${publication.channel_id}`,limit:'1'}),
    db.rows('members',{select:'id,is_active,auth_id,email_identity_verified',id:`eq.${publication.published_by}`,is_active:'eq.true',limit:'1'})
   ]);
   const batch=batches[0]?.data,event=events[0];
   if(!batch||!event||!bindings[0]||bindings[0].reconfirm_required===true||!Array.isArray(batch.components)||!batch.components.length)return undefined;
   if(!publishers[0]?.auth_id||(bindings[0].verified_by==='email'&&!memberEmailIdentityVerified(publishers[0])))return undefined;
   if(bindings[0].verified_by==='admin'&&!await trustedAdminBinding(db,bindings[0]))return undefined;
   const projectIds=[...new Set<string>(batch.components.map((c:Row)=>String(c.projectId)))];
   if(projectIds.some(id=>!/^\w[\w-]{0,199}$/.test(id)))return undefined;
   const [projects,owners]=await Promise.all([
    db.rows('projects',{select:'id,name,line_id,is_archived',id:`in.(${projectIds.join(',')})`,limit:String(projectIds.length)}),
    db.rows('members',{select:'name',id:`eq.${batch.ownerId}`,limit:'1'})
   ]);
   return{batch,event,publication,projects,ownerName:String(owners[0]?.name||''),publisherUser:bindings[0].platform_user_id,thread:links[0]?.thread_ts};
  },
  canSend:(job,owner,state)=>db.request('/rest/v1/rpc/livo_release_can_deliver','POST',{p_id:job.id,p_owner:owner,p_version:state.batch.version,p_user:state.publisherUser,p_team:state.publication.team_id,p_channel:state.publication.channel_id}),
  finish:(job,owner,result)=>db.request('/rest/v1/rpc/livo_release_finish_delivery','POST',{p_id:job.id,p_owner:owner,p_status:result.status,p_message_ts:result.messageTs||null,p_thread_ts:result.threadTs||null,p_error:result.error||null,p_delay:Math.ceil(result.delay||0)})
 };
}
export async function drainReleaseDeliveries(env:Environment,store=releaseDeliveryStore(env),fetcher:typeof fetch=fetch){
 if((await store.config())?.enabled!==true)return{enabled:false,processed:0};
 const owner=crypto.randomUUID(),until=Date.now()+30000,counts:Row={enabled:true,processed:0,sent:0,pending:0,failed:0,review:0,skipped:0};
 for(let i=0;i<5&&Date.now()<until;i++){
  const job=await store.claim(owner);if(!job)break;
  const status=await deliverRelease(job,owner,store,env.get('APP_BASE_URL')||'',fetcher);counts.processed++;counts[status]++;
 }
 return counts;
}
