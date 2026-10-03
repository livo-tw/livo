import { calendarDate, deadlineChange, reminderUntil, reminderPaused, TaskPlanningError, type DueDateKind } from '@/lib/taskPlanning/core';
import { generateId } from '@/lib/generateId';
type Row=Record<string,unknown>;
type Store=Record<string,Row[]>;
export function planningMockActor(db:Store,authId:string|undefined):string {
  const rows=(db.members||[]).filter(m=>m.auth_id===authId && m.is_active!==false);
  if (!authId || rows.length!==1) throw new TaskPlanningError('planning_forbidden',403);
  return String(rows[0].id);
}
export function planningMockUpdate(before:Row,patch:Row,actor:string,db?:Store) {
  if ('due_date_version' in patch || 'due_date_changed_by' in patch) throw new TaskPlanningError('planning_invalid_input');
  const row={...before,...patch}, version=Number(before.due_date_version||0);
  if (!('due_date' in patch) && !('due_date_kind' in patch)) { row.due_date_change_reason=null; row.due_date_changed_by=null; return {row,history:null}; }
  const next=deadlineChange({dueDate:(before.due_date as string)||null,kind:(before.due_date_kind as DueDateKind)||null,version},
    row.due_date || null, row.due_date ? row.due_date_kind??null : null,patch.due_date_change_reason);
  const required=db?.system_settings?.find(s=>s.key==='required_fields')?.value as Row|undefined;
  if(before.due_date && !next.dueDate && required?.dueDate===true)throw new TaskPlanningError('planning_date_required');
  const changed=next.dueDate!==(before.due_date||null) || next.kind!==(before.due_date_kind??null);
  Object.assign(row,{due_date:next.dueDate,due_date_kind:next.kind,due_date_version:version+(changed?1:0),due_date_change_reason:null,due_date_changed_by:null});
  const history=changed ? {id:generateId('planning'),task_id:row.id,actor_id:actor,previous_due_date:before.due_date||null,next_due_date:next.dueDate,
    previous_kind:before.due_date_kind??null,next_kind:next.kind,reason:next.reason,version:version+1,changed_at:new Date().toISOString()} : null;
  return {row,history};
}
export function planningMockRpc(db:Store,authId:string|undefined,fn:string,args:Row) {
  const actor=planningMockActor(db,authId), task=(db.tasks||[]).find(t=>t.id===args.p_task_id);
  if (!task || !(db.projects||[]).some(p=>p.id===task.project_id && !p.is_archived)) throw new TaskPlanningError('planning_unavailable',404);
  const version=args.p_expected_version;
  if (!Number.isSafeInteger(version) || Number(version)<0) throw new TaskPlanningError('planning_invalid_input');
  if (fn==='livo_set_task_reminder') {
    const until=reminderUntil(args.p_until), rows=db.task_reminder_preferences ||= [];
    const old=rows.find(p=>p.task_id===task.id && p.member_id===actor);
    if (Number(old?.version||0)!==version) throw new TaskPlanningError('planning_conflict',409);
    const saved={id:old?.id||generateId('planning'),task_id:task.id,member_id:actor,snoozed_until:until,version:Number(version)+1,updated_at:new Date().toISOString()};
    if (old) Object.assign(old,saved); else rows.push(saved);
    return {...saved};
  }
  if (Number(task.due_date_version||0)!==version) throw new TaskPlanningError('planning_conflict',409);
  const changeStart=args.p_change_start??false;
  if (typeof changeStart!=='boolean') throw new TaskPlanningError('planning_invalid_input');
  const patch:Row={due_date:args.p_due_date,due_date_kind:args.p_kind,due_date_change_reason:args.p_reason};
  if (changeStart) {
    if(args.p_expected_started_at!==null && typeof args.p_expected_started_at!=='string')throw new TaskPlanningError('planning_invalid_input');
    if ((task.started_at||null)!==(args.p_expected_started_at||null)) throw new TaskPlanningError('planning_conflict',409);
    patch.started_at=calendarDate(args.p_started_at);
  }
  // Validate before changing either the task or its history.
  if (!args.p_due_date && args.p_kind!==null) throw new TaskPlanningError('planning_date_required');
  const {row,history}=planningMockUpdate(task,patch,actor,db);
  Object.assign(task,row);
  if (history) (db.task_deadline_history ||= []).push(history);
  return {id:task.id,due_date:task.due_date,due_date_kind:task.due_date_kind,due_date_version:task.due_date_version,started_at:task.started_at??null};
}
export function planningMockSuppressed(db:Store,row:Row) {
  return row.type==='due_soon' && (db.task_reminder_preferences||[]).some(p=>p.task_id===row.task_id && p.member_id===row.recipient_id && reminderPaused(p.snoozed_until));
}
