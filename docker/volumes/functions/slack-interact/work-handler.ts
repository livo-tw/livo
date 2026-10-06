import type { Actions } from './handler.ts';
import type { Row } from './core.ts';
import { parseTaskWorkCommand, taskWorkError, TaskWorkError, type TaskWorkCommand } from './work-core.ts';
import { parseWorkSubmission, workNotice, workText } from './work-ui.ts';
import { detailModal } from './workspace-ui.ts';
import { workspaceText } from './workspace-i18n.ts';
const actions=new Set(['livo_work_open','livo_work_add','livo_work_edit','livo_work_delete','livo_work_ack','livo_work_retry']);
const suggestions=new Set(['livo_work_status','livo_work_assignee','livo_work_reviewer','livo_work_dependency']);
export async function handleWork(p:Row,d:Actions,source:Row):Promise<Row|undefined> {
  if(!d.workspace)return;
  const slash=p.command?/^work(?:\s+([A-Za-z][A-Za-z0-9_]*-\d+))?$/i.exec(String(p.text||'').trim()):null;
  const rawAction=p.type==='block_actions'?p.actions?.[0]:undefined;
  const action=rawAction&&/^livo_work_open_(checks|todos|children|dependencies|responsibility|previous|next)$/.test(rawAction.action_id)
    ? {...rawAction,action_id:'livo_work_open'}:rawAction;
  const submit=p.type==='view_submission'&&p.view?.callback_id==='livo_work_save';
  const suggest=p.type==='block_suggestion'&&suggestions.has(p.action_id);
  if(!slash&&!actions.has(action?.action_id)&&!submit&&!suggest)return;
  if(suggest)return {options:[]};
  let value:Row={},command:TaskWorkCommand|undefined;
  try {if(action)value=JSON.parse(action.value||'{}');if(submit)command=parseWorkSubmission(p.view);
    if(action?.action_id==='livo_work_retry')command=parseTaskWorkCommand(JSON.parse(p.view?.private_metadata||'{}').retryCommand);
  }catch{return submit?{response_action:'update',view:workNotice('work_invalid_input',source)}:{};}
  // Retired Slack work buttons/forms reopen a freshly authorized core task
  // card. Advanced operations remain available through LIVO and its unchanged
  // command endpoint, with the original CAS and identity checks.
  const legacyAcknowledgement=action?.action_id==='livo_work_ack'||command?.operation==='acknowledge';
  const opening=submit?undefined:await d.slack(p.view?.id?'views.update':'views.open',p.view?.id?
    {view_id:p.view.id,...(p.view.hash?{hash:p.view.hash}:{}),view:workNotice('loading',source)}:{trigger_id:p.trigger_id,view:workNotice('loading',source)});
  const workspace=d.workspace;
  d.background((async()=>{
    let view:Row,fallbackKey='work_view_unavailable';
    try {
      if(!await d.enabled())throw new TaskWorkError('work_forbidden',403);
      const actor=await d.actor(p);source={...source,locale:actor.locale};
      const task=await workspace.detail(actor,command?.taskId||slash?.[1]||value.taskId,!!slash?.[1]);
      view=detailModal(task,d.link(task),source,await workspace.comments(actor,task.id,0));
      view.blocks.unshift({type:'context',elements:[{type:'plain_text',text:legacyAcknowledgement
        ? workText('acknowledgement_obsolete',actor.locale)
        : workspaceText('進階清單、子任務與依賴操作請開啟 LIVO。',actor.locale)}]});
    } catch(error){const safe=taskWorkError(error);fallbackKey=safe.code;view=workNotice(safe.code,source);}
    await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view}).catch(async()=>{
      // A rich view can fail validation while its loading view is still open.
      // Replace it with a static notice before falling back to a private reply.
      try {await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view:workNotice(fallbackKey,source)});return;}catch{}
      // No card content or submitted text is posted.
      await d.reply({...p,channel_id:source.channel,user_id:p.user?.id||p.user_id},workText(fallbackKey,source.locale)).catch(()=>{});
    });
  })());
  return submit?{response_action:'update',view:workNotice('loading',source)}:{};
}
