import type { Actions } from './handler.ts';
import type { Row } from './core.ts';
import type { WorkSection } from './work-backend.ts';
import { parseTaskWorkCommand, taskWorkError, TaskWorkError, type TaskWorkCommand } from './work-core.ts';
import { parseWorkSubmission, workForm, workNotice, workPage, workText } from './work-ui.ts';
const actions=new Set(['livo_work_open','livo_work_add','livo_work_edit','livo_work_delete','livo_work_ack','livo_work_retry']);
const suggestions=new Set(['livo_work_status','livo_work_assignee','livo_work_reviewer','livo_work_dependency']);
const handled=new Map<string,{at:number;view:Row}>();
export async function handleWork(p:Row,d:Actions,source:Row):Promise<Row|undefined> {
  if(!d.work||!d.workspace)return;
  const slash=p.command?/^work(?:\s+([A-Za-z][A-Za-z0-9_]*-\d+))?$/i.exec(String(p.text||'').trim()):null;
  const action=p.type==='block_actions'?p.actions?.[0]:undefined;
  const submit=p.type==='view_submission'&&p.view?.callback_id==='livo_work_save';
  const suggest=p.type==='block_suggestion'&&suggestions.has(p.action_id);
  if(!slash&&!actions.has(action?.action_id)&&!submit&&!suggest)return;
  if(suggest){try{if(!await d.enabled())return {options:[]};const actor=await d.actor(p);
    return {options:p.action_id==='livo_work_dependency'?await d.work.dependencies(actor,p.value):await d.search(actor,p.action_id.slice('livo_work_'.length),p.value||'')};
  }catch{return {options:[]};}}
  let value:Row={},command:TaskWorkCommand|undefined;
  try {if(action)value=JSON.parse(action.value||'{}');if(submit)command=parseWorkSubmission(p.view);
    if(action?.action_id==='livo_work_retry')command=parseTaskWorkCommand(JSON.parse(p.view?.private_metadata||'{}').retryCommand);
  }catch{return submit?{response_action:'update',view:workNotice('work_invalid_input',source)}:{};}
  const dedup=`${p.team?.id||p.team_id}/${p.user?.id||p.user_id}/${p.view?.id}/${p.view?.hash}/${action?.action_id||p.view?.callback_id}`;
  for(const [key,item] of handled)if(item.at<Date.now()-180000)handled.delete(key);
  if(command&&handled.has(dedup))return submit?{response_action:'update',view:handled.get(dedup)!.view}:{};
  if(command)handled.set(dedup,{at:Date.now(),view:workNotice('saving',source)});
  const opening=submit?undefined:await d.slack(p.view?.id?'views.update':'views.open',p.view?.id?
    {view_id:p.view.id,...(p.view.hash?{hash:p.view.hash}:{}),view:workNotice('loading',source)}:{trigger_id:p.trigger_id,view:workNotice('loading',source)});
  const work=d.work,workspace=d.workspace;
  d.background((async()=>{
    let view:Row;
    try {
      if(!await d.enabled())throw new TaskWorkError('work_forbidden',403);
      const actor=await d.actor(p);source={...source,locale:actor.locale};
      if(command){await work.command(actor,command);view=workNotice('saved',source);}
      else {
        const task=await workspace.detail(actor,slash?.[1]||value.taskId,!!slash?.[1]);
        const section=(value.section||'responsibility') as WorkSection;
        if(slash||action?.action_id==='livo_work_open')view=workPage(await work.page(actor,task.id,section,value.page||0),source,actor.id);
        else {
          const base:Row={commandId:crypto.randomUUID(),taskId:task.id};let item:Row|undefined,required:Row={};
          if(action?.action_id==='livo_work_ack') {
            const role=value.role;
            if(!['assignee','reviewer'].includes(role)||task[`${role}_id`]!==actor.id)throw new TaskWorkError('work_forbidden',403);
            if(task[`${role}_revision`]!==value.expectedRevision)throw new TaskWorkError('work_conflict',409);
            Object.assign(base,{operation:'acknowledge',role,expectedRevision:value.expectedRevision});
          } else if(section==='checks'||section==='todos') {
            const operation=action?.action_id==='livo_work_add'?'add_item':action?.action_id==='livo_work_edit'?'update_item':'delete_item';
            Object.assign(base,{operation,list:section});
            if(operation!=='add_item') {item=await work.item(actor,task.id,section,value.itemId,value.expectedVersion);Object.assign(base,{itemId:item.id,expectedVersion:item.version});}
          } else if(section==='children'&&action?.action_id==='livo_work_add') {
            required=(await work.childConfig(actor,task.id)).required;Object.assign(base,{operation:'create_subtask'});
          } else if(section==='dependencies')Object.assign(base,action?.action_id==='livo_work_add'?{operation:'add_dependency'}:{operation:'remove_dependency',dependencyId:value.dependencyId});
          else throw new TaskWorkError('work_invalid_input');
          view=workForm(base,task,source,item,required);
        }
      }
    } catch(error){const safe=taskWorkError(error);view=workNotice(safe.code,source,safe.status>=500?command:undefined);}
    if(command)handled.set(dedup,{at:Date.now(),view});
    await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view}).catch(async()=>{
      // Private static fallback only; no card content or submitted text is posted.
      await d.reply({...p,channel_id:source.channel,user_id:p.user?.id||p.user_id},workText('work_unavailable',source.locale)).catch(()=>{});
    });
  })());
  return submit?{response_action:'update',view:workNotice('saving',source)}:{};
}
