import { generateId } from '@/lib/generateId';
import { canonicalTaskWorkPayload, parseTaskWorkCommand, TaskWorkError, type TaskWorkResult, type TaskWorkTask } from '@/lib/taskWork/core';
type Row=Record<string,unknown>; type Store=Record<string,Row[]>;
const fail=(code:string):never=>{throw new TaskWorkError(code);};
const visible=(db:Store,id:unknown):Row=>{
  const t=(db.tasks||[]).find(t=>t.id===id);
  return t&&(db.projects||[]).some(p=>p.id===t.project_id&&!p.is_archived)?t:fail('work_unavailable');
};
const table=(db:Store,name:string)=>db[name] ||= [];
function cycle(db:Store,task:unknown,target:unknown) {
  visible(db,task);visible(db,target);
  const seen=new Set<unknown>(),queue=[target];
  while(queue.length){const id=queue.pop();if(id===task)fail('work_cycle');if(seen.has(id))continue;seen.add(id);
    queue.push(...(db.task_dependencies||[]).filter(d=>d.task_id===id).map(d=>d.depends_on_task_id));}
}
export function workMockPatch(db:Store,name:string,before:Row|null,patch:Row):Row {
  if(name.startsWith('task_work_'))return fail('work_forbidden');
  const row={...before,...patch};
  if(name==='tasks') {
    if(['assignee_revision','reviewer_revision','assignee_acknowledged_at','reviewer_acknowledged_at'].some(k=>Object.prototype.hasOwnProperty.call(patch,k)))fail('work_forbidden');
    for(const role of ['assignee','reviewer']) {
      const changed=before && (before[`${role}_id`]??null)!==(row[`${role}_id`]??null);
      row[`${role}_revision`]=Number(before?.[`${role}_revision`]||0)+(changed?1:0);
      row[`${role}_acknowledged_at`]=changed?null:before?.[`${role}_acknowledged_at`]??null;
    }
    if(!before||row.parent_task_id!==before.parent_task_id||row.project_id!==before.project_id) {
      if(row.parent_task_id) {const parent=visible(db,row.parent_task_id);if(parent.id===row.id||parent.parent_task_id||parent.project_id!==row.project_id||(db.tasks||[]).some(t=>t.parent_task_id===row.id))fail('work_invalid_parent');}
      if((db.tasks||[]).some(t=>t.parent_task_id===row.id&&t.project_id!==row.project_id))fail('work_invalid_parent');
    }
    if((!before||row.task_key!==before.task_key||row.project_id!==before.project_id)&&(db.tasks||[]).some(t=>t.id!==row.id&&t.project_id===row.project_id&&t.task_key===row.task_key))fail('work_conflict');
  } else if(['task_checks','task_todos'].includes(name)) {
    if('version' in patch)fail('work_forbidden');visible(db,row.task_id);
    if(before&&(row.task_id!==before.task_id||row.id!==before.id))fail('work_conflict');
    row.version=before?Number(before.version||0)+1:0;
  } else if(name==='task_dependencies') {
    if(before)fail('work_forbidden');cycle(db,row.task_id,row.depends_on_task_id);
    if((db.task_dependencies||[]).some(d=>d.task_id===row.task_id&&d.depends_on_task_id===row.depends_on_task_id))fail('work_conflict');
  }
  return row;
}
export function taskWorkMockCommand(db:Store,authId:string|undefined,input:unknown):TaskWorkResult {
  const command=parseTaskWorkCommand(input),canonical=canonicalTaskWorkPayload(command);
  const actors=(db.members||[]).filter(m=>m.auth_id===authId&&m.is_active!==false);
  if(!authId||actors.length!==1)fail('work_forbidden');const actor=actors[0];visible(db,command.taskId);
  const saved=(db.task_work_receipts||[]).find(r=>r.id===command.commandId);
  if(saved){if(saved.actor_id!==actor.id||saved.command!==canonical)fail('work_command_reused');const current=visible(db,command.taskId);return {...saved.result as TaskWorkResult,replayed:true,task:{...(saved.result as TaskWorkResult).task,...current} as TaskWorkTask};}
  // Validate and apply against a private draft, then publish all affected rows.
  const draft:Store=JSON.parse(JSON.stringify(db)),card=visible(draft,command.taskId),stamp=new Date().toISOString();
  let record:Row|null=null,removedId:string|undefined;
  if(command.operation==='acknowledge') {
    const role=command.role;if(card[`${role}_id`]!==actor.id)fail('work_forbidden');
    if(Number(card[`${role}_revision`]||0)!==command.expectedRevision)fail('work_conflict');
    card[`${role}_acknowledged_at`] ||= stamp;
  } else if(command.operation==='create_subtask') {
    if(card.parent_task_id)fail('work_invalid_parent');
    const project=(draft.projects||[]).find(p=>p.id===card.project_id)!;
    if(!(draft.statuses||[]).some(s=>s.id===command.statusId))fail('work_invalid_input');
    for(const member of [command.assigneeId,command.reviewerId])if(member&&!(draft.members||[]).some(m=>m.id===member&&m.is_active!==false))fail('work_member_unavailable');
    const required=(draft.system_settings||[]).find(s=>s.key==='required_fields')?.value as Row||{};
    if(Object.entries(required).some(([k,v])=>v===true&&(!['dueDate','assignee','reviewer'].includes(k)||!({dueDate:command.dueDate,assignee:command.assigneeId,reviewer:command.reviewerId} as Row)[k]))
      ||(draft.custom_fields||[]).some(f=>f.project_id===project.id&&f.is_required))fail('work_required_fields');
    const next=Math.max(0,...(draft.tasks||[]).filter(t=>t.project_id===project.id).map(t=>Number(String(t.task_key).match(/(\d+)$/)?.[1]||0)))+1;
    const state=(draft.statuses||[]).find(s=>s.id===command.statusId)!;
    record=workMockPatch(draft,'tasks',null,{id:generateId('task'),task_key:`${project.key}-${next}`,project_id:project.id,parent_task_id:card.id,title:command.title,
      status_id:command.statusId,priority:command.priority,creator_id:actor.id,assignee_id:command.assigneeId,reviewer_id:command.reviewerId,due_date:command.dueDate,
      due_date_kind:null,due_date_version:0,sprint_id:card.sprint_id??null,sort_order:0,created_at:stamp,comment_count:0,started_at:state.auto_start?stamp:null,completed_at:state.auto_done?stamp:null});
    table(draft,'tasks').push(record);table(draft,'task_specs').push({id:generateId('spec'),task_id:record.id,background:'',requirement:'',notes:''});
    table(draft,'status_logs').push({id:generateId('log'),task_id:record.id,from_status_id:null,to_status_id:command.statusId,changed_by:actor.id,changed_at:stamp});
  } else if('list' in command) {
    const name=`task_${command.list}`,items=table(draft,name);
    if(command.operation==='add_item') {record=workMockPatch(draft,name,null,{id:generateId('item'),task_id:card.id,text:command.text,is_done:command.isDone,sort_order:Math.max(-1,...items.filter(i=>i.task_id===card.id).map(i=>Number(i.sort_order)))+1});items.push(record);}
    else {const index=items.findIndex(i=>i.id===command.itemId&&i.task_id===card.id),old=items[index];if(!old||Number(old.version||0)!==command.expectedVersion)fail('work_conflict');
      if(command.operation==='delete_item'){items.splice(index,1);removedId=command.itemId;}
      else {record=workMockPatch(draft,name,old,{...('text' in command?{text:command.text}:{}),...('isDone' in command?{is_done:command.isDone}:{})});items[index]=record;}}
  } else if(command.operation==='add_dependency') {
    record=workMockPatch(draft,'task_dependencies',null,{id:generateId('dep'),task_id:card.id,depends_on_task_id:command.dependsOnTaskId,dependency_type:'finish_to_start',created_at:stamp});table(draft,'task_dependencies').push(record);
  } else {const edges=table(draft,'task_dependencies'),index=edges.findIndex(d=>d.id===command.dependencyId&&d.task_id===card.id);if(index<0)fail('work_conflict');visible(draft,edges[index].depends_on_task_id);edges.splice(index,1);removedId=command.dependencyId;}
  const snapshot={...card,assignee_id:card.assignee_id??null,reviewer_id:card.reviewer_id??null,parent_task_id:card.parent_task_id??null,
    assignee_revision:Number(card.assignee_revision||0),reviewer_revision:Number(card.reviewer_revision||0),assignee_acknowledged_at:card.assignee_acknowledged_at??null,reviewer_acknowledged_at:card.reviewer_acknowledged_at??null} as TaskWorkTask;
  const result:TaskWorkResult={commandId:command.commandId,replayed:false,eventId:generateId('event'),task:snapshot,record,...(removedId?{removedId}:{})};
  table(draft,'task_work_events').push({id:result.eventId,command_id:command.commandId,actor_id:actor.id,task_id:card.id,operation:command.operation,after_value:result,created_at:stamp});
  table(draft,'task_work_receipts').push({id:command.commandId,actor_id:actor.id,task_id:card.id,command:canonical,result});
  table(draft,'activity_logs').push({id:generateId('activity'),user_id:actor.id,action:'task_work',task_id:card.id,task_key:card.task_key,detail:command.operation,created_at:stamp});
  Object.assign(db,draft);return result;
}
