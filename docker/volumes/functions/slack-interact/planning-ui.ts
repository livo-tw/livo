import type { Row } from './core.ts';
import { deadlineChange, pauseThroughDay, reminderUntil, TaskPlanningError } from './planning-core.ts';
const words:Record<string,[string,string]>={
  '期限與提醒':['期限与提醒','Deadline & reminders'],'修改期限':['修改期限','Edit deadline'],'我的到期提醒':['我的到期提醒','My due reminders'],
  '暫停到期提醒':['暂停到期提醒','Pause due reminders'],'到期日':['到期日','Due date'],'期限性質':['期限性质','Deadline kind'],
  '未指定':['未指定','Unknown'],'暫估':['暂估','Estimated'],'承諾':['承诺','Committed'],'改期原因':['改期原因','Reason for change'],
  '承諾期限延後或清除時必填原因。':['承诺期限延后或清除时必填原因。','A reason is required to postpone or clear a committed deadline.'],
  '暫停至（含當日）':['暂停至（含当日）','Pause through (inclusive)'],'只有你自己的自動到期提醒會暫停；指派、驗收、簽核、提及與完整工作摘要照常。':['仅暂停你自己的自动到期提醒；指派、验收、审批、提及和完整工作摘要不变。','Only your automatic due reminders pause. Assignment, review, approvals, mentions and full work summaries continue.'],
  '恢復提醒':['恢复提醒','Resume reminders'],'儲存':['保存','Save'],'關閉':['关闭','Close'],'返回':['返回','Back'],'下一頁':['下一页','Next'],
  '上一頁':['上一页','Previous'],'目前沒有暫停中的提醒。':['目前没有暂停中的提醒。','No active reminder pauses.'],
  '尚未暫停':['尚未暂停','Not paused'],'已儲存。':['已保存。','Saved.'],'正在載入…':['正在加载…','Loading…'],'正在儲存…':['正在保存…','Saving…'],
  '最多一年；時間依 Slack 個人時區。':['最多一年；时间依 Slack 个人时区。','Up to one year, using your Slack profile timezone.'],
  'planning_forbidden':['你的账号或绑定已变更，请重新打开。','Your account or binding changed. Reopen the form.'],
  'planning_unavailable':['卡片已不可用，请重新打开。','The card is no longer available.'],
  'planning_conflict':['资料已变更或这份表单已送出，请重新打开确认。','The data changed or this form was already submitted. Reopen to check.'],
  'planning_reason_required':['承诺期限延期或清除必须填写原因。','Enter a reason to postpone or clear a committed deadline.'],
  'planning_failed':['操作未完成，请重新打开确认。','The operation could not finish. Reopen to check.'],
};
const tw:Record<string,string>={planning_forbidden:'你的帳號或綁定已變更，請重新開啟。',planning_unavailable:'卡片已不可用，請重新開啟。',
  planning_conflict:'資料已變更或這份表單已送出，請重新開啟確認。',planning_reason_required:'承諾期限延期或清除必須填寫原因。',planning_failed:'操作未完成，請重新開啟確認。'};
export function planningText(text:string,locale='zh-TW') {
  if(text.startsWith('planning_') && !words[text]) return locale.startsWith('en')?'Check the date, deadline kind, reason and pause range.':locale==='zh-CN'?'请检查日期、期限性质、原因与暂停范围。':'請檢查日期、期限性質、原因與暫停範圍。';
  return locale.startsWith('en')?words[text]?.[1]||text:locale==='zh-CN'?words[text]?.[0]||text:tw[text]||text;
}
const plain=(text:string)=>({type:'plain_text',text:text.slice(0,2800)});
const section=(text:string)=>({type:'section',text:plain(text)});
export const planningButton=(id:string,label:string,value:Row,locale?:string)=>({type:'button',action_id:id,text:plain(planningText(label,locale)),value:JSON.stringify(value)});
const actions=(elements:Row[])=>({type:'actions',elements});
function base(callback:string,title:string,source:Row,blocks:Row[],meta:Row={},submit?:string):Row {
  return {type:'modal',callback_id:callback,title:plain(planningText(title,source.locale)),close:plain(planningText('關閉',source.locale)),
    ...(submit?{submit:plain(planningText(submit,source.locale))}:{}),private_metadata:JSON.stringify({channel:source.channel||'',locale:source.locale,...meta}),blocks};
}
const input=(id:string,label:string,element:Row,locale:string,optional=false)=>({type:'input',block_id:id,label:plain(planningText(label,locale)),element:{...element,action_id:id},optional});
const opt=(value:string,label:string,locale:string)=>({value,text:plain(planningText(label,locale))});
export function planningForm(kind:'deadline'|'reminder',task:Row,pref:Row,source:Row):Row {
  const locale=source.locale||'zh-TW', timeZone=source.timezone||'Asia/Taipei';
  const blocks:Row[]=[section(`${task.task_key} · ${task.title}`)];
  if(kind==='deadline') blocks.push(
    input('date','到期日',{type:'datepicker',...(task.due_date?{initial_date:task.due_date}:{})},locale,true),
    input('kind','期限性質',{type:'static_select',initial_option:opt(task.due_date_kind||'unknown',task.due_date_kind==='committed'?'承諾':task.due_date_kind==='estimated'?'暫估':'未指定',locale),
      options:[opt('unknown','未指定',locale),opt('estimated','暫估',locale),opt('committed','承諾',locale)]},locale),
    input('reason','改期原因',{type:'plain_text_input',multiline:true,max_length:2000},locale,true),
    section(planningText('承諾期限延後或清除時必填原因。',locale)));
  else blocks.push(section(planningText('只有你自己的自動到期提醒會暫停；指派、驗收、簽核、提及與完整工作摘要照常。',locale)),
    section(`${pref.snoozed_until||planningText('尚未暫停',locale)} · ${timeZone}`),
    input('through','暫停至（含當日）',{type:'datepicker'},locale),section(planningText('最多一年；時間依 Slack 個人時區。',locale)),
    actions([planningButton('livo_reminder_resume','恢復提醒',{taskId:task.id,version:pref.version||0},locale)]));
  blocks.push(actions([planningButton('livo_task_open','返回',{taskId:task.id},locale)]));
  return base(`livo_planning_${kind}`,kind==='deadline'?'修改期限':'暫停到期提醒',source,blocks,
    {taskId:task.id,version:kind==='deadline'?task.due_date_version||0:pref.version||0,expected:{dueDate:task.due_date||null,kind:task.due_date_kind||null},timeZone},'儲存');
}
export function planningList(rows:Row[],page:number,hasMore:boolean,source:Row):Row {
  const locale=source.locale||'zh-TW',blocks:Row[]=[];
  if(!rows.length)blocks.push(section(planningText('目前沒有暫停中的提醒。',locale)));
  for(const row of rows){const t=Array.isArray(row.tasks)?row.tasks[0]:row.tasks;blocks.push(section(`${t.task_key} · ${t.title}\n${row.snoozed_until}`),
    actions([planningButton('livo_reminder_open','暫停到期提醒',{taskId:row.task_id},locale),planningButton('livo_reminder_resume','恢復提醒',{taskId:row.task_id,version:row.version},locale)]));}
  const nav=[];if(page>0)nav.push(planningButton('livo_reminders','上一頁',{page:page-1},locale));if(hasMore)nav.push(planningButton('livo_reminders','下一頁',{page:page+1},locale));
  if(nav.length)blocks.push(actions(nav));
  return base('livo_planning_list','我的到期提醒',source,blocks);
}
export function planningNotice(text:string,source:Row,taskId?:string):Row {
  return base('livo_planning_notice','期限與提醒',source,[section(planningText(text,source.locale)),
    actions([taskId?planningButton('livo_task_open','返回',{taskId},source.locale):planningButton('livo_reminders','我的到期提醒',{page:0},source.locale)])]);
}
export function parsePlanning(view:Row):{kind:'deadline'|'reminder';fields:Row} {
  let meta:Row;try{meta=JSON.parse(view.private_metadata||'{}');}catch{throw new TaskPlanningError('planning_invalid_input');}
  if(!meta.taskId||!Number.isSafeInteger(meta.version)||meta.version<0)throw new TaskPlanningError('planning_invalid_input');
  const values=view.state?.values||{};
  if(view.callback_id==='livo_planning_deadline') {
    if(!meta.expected || !('dueDate' in meta.expected) || !('kind' in meta.expected))throw new TaskPlanningError('planning_invalid_input');
    const date=values.date?.date && Object.prototype.hasOwnProperty.call(values.date.date,'selected_date') ? values.date.date.selected_date : meta.expected.dueDate;
    const kind=values.kind?.kind?.selected_option?.value ?? meta.expected.kind;
    const next=deadlineChange({...meta.expected,version:meta.version},date,kind==='unknown'?null:kind,values.reason?.reason?.value);
    return {kind:'deadline',fields:{taskId:meta.taskId,version:meta.version,date:next.dueDate,kind:next.kind,reason:next.reason}};
  }
  const day=values.through?.through?.selected_date;
  if(typeof day!=='string')throw new TaskPlanningError('planning_invalid_date');
  return {kind:'reminder',fields:{taskId:meta.taskId,version:meta.version,until:reminderUntil(pauseThroughDay(day,meta.timeZone))}};
}
