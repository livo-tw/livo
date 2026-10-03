import type { Row } from './core.ts';
import type { WorkPage, WorkSection } from './work-backend.ts';
import { parseTaskWorkCommand, type TaskWorkCommand } from './work-core.ts';
const words:Record<string,[string,string,string]>={
  title:['卡片工作','卡片工作','Task work'],checks:['驗收清單','验收清单','Checklist'],todos:['待辦事項','待办事项','To-dos'],children:['子任務','子任务','Subtasks'],dependencies:['前置任務','前置任务','Dependencies'],responsibility:['接手確認','接手确认','Acknowledgement'],
  close:['關閉','关闭','Close'],save:['確認儲存','确认保存','Confirm'],loading:['正在載入…','正在加载…','Loading…'],saving:['正在儲存…','正在保存…','Saving…'],saved:['已儲存。','已保存。','Saved.'],
  add:['新增','新增','Add'],edit:['編輯','编辑','Edit'],remove:['刪除','删除','Delete'],text:['內容','内容','Text'],done:['完成','完成','Done'],pending:['未完成','未完成','Not done'],previous:['上一頁','上一页','Previous'],next:['下一頁','下一页','Next'],empty:['目前沒有項目。','目前没有项目。','No items yet.'],
  childTitle:['子任務標題','子任务标题','Subtask title'],status:['狀態','状态','Status'],assignee:['經辦人','经办人','Assignee'],reviewer:['驗收人','验收人','Reviewer'],due:['期限','期限','Due date'],priority:['優先級','优先级','Priority'],
  acknowledge:['確認接手','确认接手','Acknowledge'],ackInfo:['只確認已接手本次指派，不會變更狀態或代表驗收通過。','只确认已接手本次指派，不会改变状态或代表验收通过。','Acknowledges this assignment only. It does not change status or approve acceptance.'],
  acked:['已確認接手','已确认接手','Acknowledged'],unacked:['尚未確認接手','尚未确认接手','Not acknowledged'],deleteInfo:['確認刪除此項目？','确认删除此项目？','Delete this item?'],
  unknown:['無法存取的項目','无法访问的项目','Unavailable item'],retry:['重試同一操作','重试同一操作','Retry this operation'],
  work_invalid_input:['表單內容不完整，請重新開啟。','表单内容不完整，请重新打开。','The form is incomplete. Reopen it.'],
  work_conflict:['資料已變更，這次未儲存。請重新開啟並確認。','资料已变更，本次未保存。请重新打开并确认。','The data changed. Nothing was saved. Reopen and review.'],
  work_command_reused:['這份表單已用於其他內容，請重新開啟。','此表单已用于其他内容，请重新打开。','This form was used for different content. Reopen it.'],
  work_forbidden:['目前無權進行這項操作，請重新確認帳號與指派。','目前无权执行此操作，请重新确认账号与指派。','This action is unavailable for your current account or assignment.'],
  work_unauthorized:['帳號連線已失效，請重新開啟。','账号连接已失效，请重新打开。','Your session expired. Reopen this form.'],
  work_unavailable:['無法確認儲存結果。可重試同一操作；請勿另外重建重複項目。','无法确认保存结果。可重试同一操作；请勿另外创建重复项目。','The result could not be confirmed. Retry this operation without creating another copy.'],
  work_cycle:['這個依賴會形成循環，未儲存。','此依赖会形成循环，未保存。','This dependency would form a cycle. Nothing was saved.'],
  work_invalid_parent:['子任務只支援同專案一層，請確認母卡。','子任务只支持同项目一层，请确认父卡。','Subtasks support one level in the same project. Check the parent.'],
  work_member_unavailable:['選取的成員已不可用，請重新開啟。','所选成员已不可用，请重新打开。','A selected member is unavailable. Reopen the form.'],
  work_required_fields:['有其他必填欄位，請在 LIVO 建立子任務；本次沒有建立半張卡片。','有其他必填字段，请在 LIVO 创建子任务；本次没有创建部分卡片。','Additional required fields must be completed in LIVO. No partial task was created.'],
};
export function workText(key:string,locale='zh-TW'){return (words[key]||words.work_unavailable)[locale.startsWith('en')?2:/CN|Hans/i.test(locale)?1:0];}
const plain=(text:unknown):Row=>({type:'plain_text',text:String(text||'—').slice(0,2800)});
const section=(text:unknown):Row=>({type:'section',text:plain(text)});
export const workButton=(action:string,key:string,value:Row,locale?:string):Row=>({type:'button',action_id:action,text:plain(workText(key,locale)),value:JSON.stringify(value)});
const actions=(elements:Row[]):Row=>({type:'actions',elements});
const safeSource=(source:Row)=>Object.fromEntries(['channel','thread','user','team','locale'].filter(k=>typeof source[k]==='string').map(k=>[k,String(source[k]).slice(0,150)]));
const modal=(blocks:Row[],source:Row,data:Row={},submit=false):Row=>({type:'modal',callback_id:submit?'livo_work_save':'livo_work_view',
  title:plain(workText('title',source.locale)),close:plain(workText('close',source.locale)),...(submit?{submit:plain(workText('save',source.locale))}:{}),
  private_metadata:JSON.stringify({...safeSource(source),...data}),blocks});
const option=(value:string,label:string):Row=>({text:plain(label),value});
const input=(key:string,element:Row,source:Row,optional=false):Row=>({type:'input',block_id:key,label:plain(workText(key,source.locale)),optional,element:{...element,action_id:'value'}});
export function workNotice(key:string,source:Row,command?:TaskWorkCommand):Row {
  return modal([section(workText(key,source.locale)),...(command?[actions([workButton('livo_work_retry','retry',{},source.locale)])]:[])],source,command?{retryCommand:command}:{});
}
export function workPage(page:WorkPage,source:Row,memberId:string):Row {
  const {task,section:kind}=page,base={taskId:task.id,section:kind,page:page.page},blocks:Row[]=[section(`${task.task_key} · ${task.title}`),
    actions((['checks','todos','children','dependencies','responsibility'] as WorkSection[]).map(section=>workButton('livo_work_open',section,{taskId:task.id,section,page:0},source.locale)))];
  if(kind==='responsibility') {
    blocks.push(section(workText('ackInfo',source.locale)));
    for(const role of ['assignee','reviewer']) {
      blocks.push(section(`${workText(role,source.locale)} · ${workText(task[`${role}_acknowledged_at`]?'acked':'unacked',source.locale)}`));
      if(task[`${role}_id`]===memberId&&!task[`${role}_acknowledged_at`])blocks.push(actions([workButton('livo_work_ack','acknowledge',{taskId:task.id,role,expectedRevision:task[`${role}_revision`]},source.locale)]));
    }
  } else {
    blocks.push(actions([workButton('livo_work_add','add',base,source.locale)]));
    if(!page.rows.length)blocks.push(section(workText('empty',source.locale)));
    for(const row of page.rows) {
      if(row.unavailable){blocks.push(section(workText('unknown',source.locale)));continue;}
      if(kind==='checks'||kind==='todos') {blocks.push(section(`${row.is_done?'☑':'☐'} ${row.text}`),actions([
        workButton('livo_work_edit','edit',{...base,itemId:row.id,expectedVersion:row.version},source.locale),
        workButton('livo_work_delete','remove',{...base,itemId:row.id,expectedVersion:row.version},source.locale)]));}
      else if(kind==='children')blocks.push(section(`${row.task_key} · ${row.title}`));
      else blocks.push(section(`${row.target.task_key} · ${row.target.title}`),actions([workButton('livo_work_delete','remove',{...base,dependencyId:row.id},source.locale)]));
    }
    const nav:Row[]=[];
    if(page.page>0)nav.push(workButton('livo_work_open','previous',{...base,page:page.page-1},source.locale));
    if(page.hasMore)nav.push(workButton('livo_work_open','next',{...base,page:page.page+1},source.locale));
    if(nav.length)blocks.push(actions(nav));
  }
  return modal(blocks,source);
}
export function workForm(command:Row,task:Row,source:Row,item?:Row,required:Row={}):Row {
  const blocks:Row[]=[section(`${task.task_key} · ${task.title}`)];
  if(command.operation==='acknowledge')blocks.push(section(workText(command.role,source.locale)),section(workText('ackInfo',source.locale)));
  else if(command.operation==='delete_item'||command.operation==='remove_dependency')blocks.push(section(workText('deleteInfo',source.locale)),...(item?[section(item.text)]:[]));
  else if(command.operation==='add_item'||command.operation==='update_item') {
    blocks.push(input('text',{type:'plain_text_input',multiline:true,max_length:2000,...(item?{initial_value:item.text}:{})},source));
    const options=[option('false',workText('pending',source.locale)),option('true',workText('done',source.locale))];
    blocks.push(input('done',{type:'static_select',options,initial_option:options[item?.is_done?1:0]},source));
  } else if(command.operation==='create_subtask') {
    blocks.push(input('childTitle',{type:'plain_text_input',max_length:500},source));
    for(const field of ['status','assignee','reviewer'])blocks.push({type:'input',block_id:field,label:plain(workText(field,source.locale)),optional:field!=='status'&&!required[field],
      element:{type:'external_select',action_id:`livo_work_${field}`,min_query_length:0,placeholder:plain(workText(field,source.locale))}});
    blocks.push(input('due',{type:'datepicker'},source,!required.dueDate));
    const options=[['highest','最高','最高','Highest'],['high','高','高','High'],['medium','中','中','Medium'],['low','低','低','Low'],['lowest','最低','最低','Lowest']].map(([v,a,b,c])=>option(v,source.locale?.startsWith('en')?c:/CN|Hans/i.test(source.locale)?b:a));
    blocks.push(input('priority',{type:'static_select',options,initial_option:options[2]},source));
  } else blocks.push({type:'input',block_id:'dependency',label:plain(workText('dependencies',source.locale)),element:{type:'external_select',action_id:'livo_work_dependency',min_query_length:0}});
  return modal(blocks,source,{command},true);
}
export function parseWorkSubmission(view:Row):TaskWorkCommand {
  const meta=JSON.parse(view.private_metadata||'{}'),command=meta.command,values=view.state?.values||{};
  const field=(key:string)=>Object.values(values[key]||{})[0] as Row|undefined;
  let fields:Row={};
  if(command?.operation==='add_item'||command?.operation==='update_item')fields={text:field('text')?.value,isDone:field('done')?.selected_option?.value==='true'};
  if(command?.operation==='create_subtask')fields={title:field('childTitle')?.value,statusId:field('status')?.selected_option?.value,
    assigneeId:field('assignee')?.selected_option?.value??null,reviewerId:field('reviewer')?.selected_option?.value??null,
    dueDate:field('due')?.selected_date??null,priority:field('priority')?.selected_option?.value};
  if(command?.operation==='add_dependency')fields={dependsOnTaskId:field('dependency')?.selected_option?.value};
  return parseTaskWorkCommand({...command,...fields});
}
