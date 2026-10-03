import type { Row } from './core.ts';
import type { MemberDatabase } from './workspace-backend.ts';
import { TaskPlanningError, calendarDate, dueDateKind, reminderUntil } from './planning-core.ts';
export interface PlanningData {
  preference(actor:Row,taskId:string):Promise<Row>;
  list(actor:Row,page:number):Promise<{rows:Row[];hasMore:boolean}>;
  save(actor:Row,kind:'deadline'|'reminder',fields:Row):Promise<Row>;
}
export function createPlanningData(memberDb:(actor:Row)=>MemberDatabase):PlanningData {
  const db=(actor:Row)=>{if(!actor.jwt) throw new TaskPlanningError('planning_forbidden');return memberDb(actor);};
  const id=(value:unknown)=>{if(typeof value!=='string'||! /^[\w-]{1,200}$/.test(value))throw new TaskPlanningError('planning_invalid_input');return value;};
  return {
    async preference(actor,taskId) {
      return (await db(actor).rows('task_reminder_preferences',{select:'*',task_id:`eq.${id(taskId)}`,member_id:`eq.${id(actor.id)}`,limit:'1'}))[0] || {task_id:taskId,version:0,snoozed_until:null};
    },
    async list(actor,page) {
      if(!Number.isSafeInteger(page)||page<0||page>10000)throw new TaskPlanningError('planning_invalid_input');
      const rows=await db(actor).rows('task_reminder_preferences',{select:'*,tasks!inner(id,task_key,title,projects!inner(is_archived))',member_id:`eq.${id(actor.id)}`,
        'tasks.projects.is_archived':'eq.false',snoozed_until:`gt.${new Date().toISOString()}`,order:'snoozed_until.asc,id.asc',limit:'11',offset:String(page*10)});
      return {rows:rows.slice(0,10),hasMore:rows.length>10};
    },
    async save(actor,kind,fields) {
      const args:Row={p_task_id:id(fields.taskId),p_expected_version:fields.version};
      if(!Number.isSafeInteger(fields.version)||fields.version<0)throw new TaskPlanningError('planning_invalid_input');
      if(kind==='reminder') args.p_until=reminderUntil(fields.until);
      else Object.assign(args,{p_due_date:calendarDate(fields.date),p_kind:dueDateKind(fields.kind),p_reason:fields.reason||null});
      return db(actor).request(`/rest/v1/rpc/livo_set_task_${kind}`,'POST',args);
    },
  };
}
