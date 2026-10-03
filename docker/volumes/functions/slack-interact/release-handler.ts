import type {Actions} from './handler.ts';
import type {Row} from './core.ts';
import {ReleaseError,releaseError,type ReleaseBatch,type ReleaseCommand} from './release-core.ts';
import {releaseDetail,releaseForm,releaseList,releaseNotice,releaseSubmission,releaseText,releaseInputFingerprint,releasePendingForm} from './release-ui.ts';
const known=new Set(['livo_release_list','livo_release_new','livo_release_open','livo_release_form']);
const generations=new Map<string,number>();
const identity=(p:Row)=>`${p.team?.id||p.team_id}/${p.user?.id||p.user_id}`;
async function channelMember(d:Actions,channel:string,user:string){let cursor='';for(let page=0;page<50;page++){const r=await d.slack('conversations.members',{channel,limit:200,...(cursor?{cursor}:{})});if(!Array.isArray(r.members))throw new ReleaseError('release_forbidden',403);if(r.members.includes(user))return;cursor=r.response_metadata?.next_cursor||'';if(!cursor)break;}throw new ReleaseError('release_forbidden',403);}
export async function handleRelease(p:Row,d:Actions,source:Row):Promise<Row|undefined>{
 if(!d.releases)return;
 const slash=p.command?/^(releases|release)(?:\s+(new|[A-Za-z0-9_-]{1,128}))?$/i.exec(String(p.text||'').trim()):null;
 const rawAction=p.type==='block_actions'?p.actions?.[0]:undefined,action=rawAction?{...rawAction,action_id:String(rawAction.action_id).split(':')[0]}:undefined,submit=p.type==='view_submission'&&p.view?.callback_id==='livo_release_save';
 const suggestion=p.type==='block_suggestion'&&['livo_release_project','livo_release_owner','livo_release_tasks','livo_release_qa_issue','livo_release_qa_target','livo_release_qa_run'].includes(p.action_id);
 if(!slash&&!known.has(action?.action_id)&&!submit&&!suggestion)return;
 if(suggestion){try{if(!await d.enabled())return {options:[]};const actor=await d.actor(p);
  const pin=JSON.parse(p.view?.private_metadata||'{}');if(pin.actorId!==actor.id||pin.bindingId!==actor.binding_id)return {options:[]};
  if(p.action_id==='livo_release_project')return {option_groups:await d.search(actor,'project',p.value||'')};
  if(p.action_id==='livo_release_owner')return {options:await d.search(actor,'assignee',p.value||'')};
  if(p.action_id.startsWith('livo_release_qa_')){const m=JSON.parse(p.view?.private_metadata||'{}'),state=p.view?.state?.values||{},batch=await d.releases.request(actor,{action:'get',batchId:m.batchId}) as ReleaseBatch;if(batch.version!==m.version)return {options:[]};const c=batch.components.find(c=>c.id===m.componentId),environment=state.environment?.value?.selected_option?.value,target=c?.targets.find(t=>t.environment===environment);if(!c||!target)return {options:[]};const issue=JSON.parse(state.issueId?.livo_release_qa_issue?.selected_option?.value||'null');return {options:await d.releases.qaOptions(actor,p.action_id.slice('livo_release_qa_'.length),p.value||'',{projectId:c.projectId,component:c.name,environment,build:target.build,issue,targetId:state.targetId?.livo_release_qa_target?.selected_option?.value})};}
  const project=p.view?.state?.values?.project?.livo_release_project?.selected_option?.value;
  return {options:project?await d.releases.tasks(actor,project,p.value||''):[]};
 }catch{return {options:[]};}}
 let value:Row={};try{if(action)value=JSON.parse(action.value||'{}');}catch{return {};}
 const who=identity(p),viewKey=`${who}/${p.view?.id||p.trigger_id}`;
 const fingerprint=submit?await releaseInputFingerprint(p.view):'';
 if(submit){const m=JSON.parse(p.view.private_metadata||'{}');if(m.fieldsHash&&m.fieldsHash!==fingerprint)return {response_action:'update',view:releaseNotice('release_command_reused',source)};}
 if(generations.size>=500&&!generations.has(viewKey))generations.delete(generations.keys().next().value!);
 const generation=(generations.get(viewKey)||0)+1;generations.set(viewKey,generation);
 const opened=submit?undefined:await d.slack(p.view?.id?'views.update':'views.open',p.view?.id?{view_id:p.view.id,...(p.view.hash?{hash:p.view.hash}:{}),view:releaseNotice('loading',source)}:{trigger_id:p.trigger_id,view:releaseNotice('loading',source)});
 const api=d.releases;
 d.background((async()=>{
  let view:Row,command:ReleaseCommand|undefined,committed=false,recovered=false;
  try{
   if(!await d.enabled())throw new ReleaseError('release_forbidden',403);
   const actor=await d.actor(p);source={...source,locale:actor.locale};const manage=['admin','super_admin'].includes(actor.role);
   if(submit){const metadata=JSON.parse(p.view.private_metadata||'{}');if(metadata.actorId!==actor.id||metadata.bindingId!==actor.binding_id)throw new ReleaseError('release_forbidden',403);const receipt=await api.request(actor,{action:'receipt',commandId:metadata.commandId,batchId:metadata.batchId});
    if(receipt.found){committed=true;recovered=true;}else{const batch=metadata.form==='new'?undefined:await api.request(actor,{action:'get',batchId:metadata.batchId}) as ReleaseBatch;command=releaseSubmission(p.view,batch);}}
   if(committed)view=releaseNotice('recovered',source);
   else if(command){if(command.operation==='publish_thread'){if(command.teamId!==(p.team?.id||p.team_id)||command.channelId!==source.channel)throw new ReleaseError('release_forbidden',403);await channelMember(d,command.channelId,p.user?.id||p.user_id);}await api.request(actor,{action:'command',command});committed=true;view=releaseNotice('saved',source);}
   else if((slash&&!slash[2])||action?.action_id==='livo_release_list')view=releaseList(await api.request(actor,{action:'list',page:value.page||0}),source);
   else if(slash?.[2]?.toLowerCase()==='new'||action?.action_id==='livo_release_new'){
    if(!manage)throw new ReleaseError('release_forbidden',403);view=releaseForm('new',{batchId:crypto.randomUUID(),componentId:crypto.randomUUID(),commandId:crypto.randomUUID(),version:0,actorId:actor.id,bindingId:actor.binding_id},source,undefined,await api.environments(actor));
   }else{
    const batch=await api.request(actor,{action:'get',batchId:slash?.[2]||value.batchId}) as ReleaseBatch;
    if(action?.action_id==='livo_release_form'){
     if(!manage)throw new ReleaseError('release_forbidden',403);if(batch.version!==value.version)throw new ReleaseError('release_conflict',409);
     const forms=['edit','add_component','target','qa','uat','start','request_exception','approved','rejected','deployed','failed','rollback','recovery','maintenance_start','maintenance_end','complete','cancel','publish_thread'];
     if(!forms.includes(value.form))throw new ReleaseError('release_invalid_input');
     if(value.form==='publish_thread'){if(!/^C[A-Z0-9]+$/.test(source.channel||''))throw new ReleaseError('release_forbidden',403);await channelMember(d,source.channel,p.user?.id||p.user_id);}
     view=releaseForm(value.form,{...value,commandId:crypto.randomUUID(),actorId:actor.id,bindingId:actor.binding_id,...(value.form==='publish_thread'?{teamId:p.team?.id||p.team_id,channelId:source.channel}:{}),...(value.form==='add_component'?{componentId:crypto.randomUUID()}:{})},source,batch,['add_component','target','qa','uat','start'].includes(value.form)?await api.environments(actor):[]);
    }else{
     const section=value.section||'overview',page=value.page||0;if(!['overview','components','evidence','exceptions','attempts','maintenance','events'].includes(section)||!Number.isInteger(page)||page<0||page>10000)throw new ReleaseError('release_invalid_input');
     view=releaseDetail(batch,source,section,page,section==='events'?await api.request(actor,{action:'events',batchId:batch.id,page}):undefined,manage);
    }
   }
  }catch(error){const safe=releaseError(error);
   view=submit&&safe.status>=500?releasePendingForm(p.view,source,safe.code,fingerprint):releaseNotice(safe.code,source);
  }
  if(generations.get(viewKey)!==generation)return;
  await d.slack('views.update',{view_id:p.view?.id||opened?.view?.id,...(!submit&&opened?.view?.hash?{hash:opened.view.hash}:{}),view}).catch(async()=>{
   // A failed private UI refresh never changes the recorded command result or broadcasts private fields.
   await d.reply({channel_id:source.channel,user_id:p.user?.id||p.user_id},releaseText(recovered?'recovered':committed?'saved':'release_unavailable',source.locale)).catch(()=>{});
  });
 })());
 return submit?{response_action:'update',view:releasePendingForm(p.view,source,'saving',fingerprint)}:{};
}
