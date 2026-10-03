import type { Actions } from './handler.ts';
import type { Row } from './core.ts';
import { TaskPlanningError } from './planning-core.ts';
import { parsePlanning, planningForm, planningList, planningNotice, planningText } from './planning-ui.ts';
const ids=new Set(['livo_deadline_open','livo_reminder_open','livo_reminder_resume','livo_reminders']);
const handled=new Map<string,number>();
const safe=(error:unknown)=>error instanceof TaskPlanningError?error.code:'planning_failed';
export async function handlePlanning(p:Row,d:Actions,source:Row):Promise<Row|undefined> {
  if(!d.planning||!d.workspace)return;
  const command=p.command ? /^(reminders|pause|deadline)(?:\s+([A-Za-z][A-Za-z0-9_]*-\d+))?$/i.exec(String(p.text||'').trim()) : null;
  const action=p.type==='block_actions'?p.actions?.[0]:undefined;
  const submit=p.type==='view_submission' && ['livo_planning_deadline','livo_planning_reminder'].includes(p.view?.callback_id);
  if(!command&&!ids.has(action?.action_id)&&!submit)return;
  let parsed:ReturnType<typeof parsePlanning>|undefined,value:Row={};
  try { if(submit)parsed=parsePlanning(p.view);else if(action)value=JSON.parse(action.value||'{}'); }
  catch(error){return {response_action:'errors',errors:{[p.view?.callback_id==='livo_planning_deadline'?'reason':'through']:planningText(safe(error),source.locale)}};}
  const isResume=action?.action_id==='livo_reminder_resume';
  if(submit||isResume){
    const key=`${p.team_id||p.team?.id}:${p.user_id||p.user?.id}:${p.view?.id}:${p.view?.hash}:${action?.action_id||p.view?.callback_id}`;
    for(const [k,at] of handled)if(at<Date.now()-180000)handled.delete(k);
    if(handled.has(key))return submit?{response_action:'update',view:planningNotice('正在儲存…',source)}:{};
    handled.set(key,Date.now());
  }
  const opening=submit?null:await d.slack(p.view?.id?'views.update':'views.open',p.view?.id?
    {view_id:p.view.id,...(p.view.hash?{hash:p.view.hash}:{}),view:planningNotice('正在載入…',source)}:
    {trigger_id:p.trigger_id,view:planningNotice('正在載入…',source)});
  const planning=d.planning,workspace=d.workspace;
  d.background((async()=>{
    let view:Row;
    try {
      if(!await d.enabled())throw new TaskPlanningError('planning_forbidden');
      const actor=await d.actor(p);source={...source,locale:actor.locale,timezone:actor.timezone};
      if(parsed||isResume){
        const fields=parsed?.fields||{taskId:value.taskId,version:value.version,until:null};
        await planning.save(actor,parsed?.kind||'reminder',fields);
        view=planningNotice('已儲存。',source,fields.taskId);
      }else if(command?.[1].toLowerCase()==='reminders'||action?.action_id==='livo_reminders'){
        const page=value.page??0,result=await planning.list(actor,page);view=planningList(result.rows,page,result.hasMore,source);
      }else{
        const key=command?.[2],task=await workspace.detail(actor,key||value.taskId,!!key);
        const kind=command?.[1].toLowerCase()==='deadline'||action?.action_id==='livo_deadline_open'?'deadline':'reminder';
        view=planningForm(kind,task,kind==='reminder'?await planning.preference(actor,task.id):{},source);
      }
    }catch(error){view=planningNotice(safe(error),source);}
    await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view}).catch(async()=>{
      // Static private fallback only: never echo card data into a shared channel.
      await d.reply({...p,channel_id:source.channel,user_id:p.user?.id||p.user_id},planningText('planning_failed',source.locale)).catch(()=>{});
    });
  })());
  return submit?{response_action:'update',view:planningNotice('正在儲存…',source)}:{};
}
