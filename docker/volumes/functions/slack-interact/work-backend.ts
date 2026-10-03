import type { Row } from './core.ts';
import type { MemberDatabase } from './workspace-backend.ts';
import { parseTaskWorkCommand, TaskWorkError, TASK_WORK_ERRORS, type TaskWorkCommand, type TaskWorkResult } from './work-core.ts';
export type WorkSection='checks'|'todos'|'children'|'dependencies'|'responsibility';
export type WorkPage={task:Row;section:WorkSection;rows:Row[];page:number;hasMore:boolean};
export interface WorkData {
  page(actor:Row,taskId:string,section:WorkSection,page:number):Promise<WorkPage>;
  item(actor:Row,taskId:string,list:'checks'|'todos',itemId:string,version:number):Promise<Row>;
  childConfig(actor:Row,taskId:string):Promise<Row>;
  dependencies(actor:Row,query:string):Promise<Row[]>;
  command(actor:Row,command:TaskWorkCommand):Promise<TaskWorkResult>;
}
const identifier=(v:unknown):string=>{if(typeof v!=='string'||!/^[\w-]{1,200}$/.test(v))throw new TaskWorkError('work_invalid_input');return v;};
const dbFor=(factory:(actor:Row)=>MemberDatabase,actor:Row)=>{if(!actor.jwt)throw new TaskWorkError('work_forbidden',403);return factory(actor);};
const active={'projects.is_archived':'eq.false'};
export function createWorkData(factory:(actor:Row)=>MemberDatabase,execute:(actor:Row,command:TaskWorkCommand)=>Promise<TaskWorkResult>):WorkData {
  const task=async(db:MemberDatabase,taskId:string)=>{
    const rows=await db.rows('tasks',{select:'*,projects!inner(id,name,is_archived)',id:`eq.${identifier(taskId)}`,...active,limit:'1'});
    if(rows.length!==1)throw new TaskWorkError('work_unavailable',404);return rows[0];
  };
  return {
    async page(actor,taskId,section,page){
      if(!['checks','todos','children','dependencies','responsibility'].includes(section)||!Number.isSafeInteger(page)||page<0||page>10000)throw new TaskWorkError('work_invalid_input');
      const db=dbFor(factory,actor),card=await task(db,taskId);let rows:Row[]=[];
      if(section==='checks'||section==='todos')rows=await db.rows(`task_${section}`,{select:'id,task_id,text,is_done,sort_order,version',task_id:`eq.${card.id}`,order:'sort_order.asc,id.asc',limit:'9',offset:String(page*8)});
      if(section==='children')rows=await db.rows('tasks',{select:'id,task_key,title,statuses(name),projects!inner(id,is_archived)',parent_task_id:`eq.${card.id}`,...active,order:'task_key.asc,id.asc',limit:'9',offset:String(page*8)});
      if(section==='dependencies') {
        rows=await db.rows('task_dependencies',{select:'id,task_id,depends_on_task_id',task_id:`eq.${card.id}`,order:'created_at.asc,id.asc',limit:'9',offset:String(page*8)});
        rows=await Promise.all(rows.map(async edge=>{try {const other=await task(db,edge.depends_on_task_id);return {...edge,target:{id:other.id,task_key:other.task_key,title:other.title}};}catch{return {unavailable:true};}}));
      }
      return {task:card,section,rows:rows.slice(0,8),page,hasMore:rows.length>8};
    },
    async item(actor,taskId,list,itemId,version){
      if(!['checks','todos'].includes(list)||!Number.isSafeInteger(version)||version<0)throw new TaskWorkError('work_invalid_input');
      const db=dbFor(factory,actor);await task(db,taskId);
      const rows=await db.rows(`task_${list}`,{select:'id,task_id,text,is_done,sort_order,version',task_id:`eq.${identifier(taskId)}`,id:`eq.${identifier(itemId)}`,limit:'1'});
      if(rows.length!==1||rows[0].version!==version)throw new TaskWorkError('work_conflict',409);return rows[0];
    },
    async childConfig(actor,taskId){
      const db=dbFor(factory,actor),card=await task(db,taskId);if(card.parent_task_id)throw new TaskWorkError('work_invalid_parent',409);
      const [settings,custom]=await Promise.all([db.rows('system_settings',{select:'value',key:'eq.required_fields',limit:'1'}),
        db.rows('custom_fields',{select:'id',project_id:`eq.${identifier(card.project_id)}`,is_required:'eq.true',limit:'1'})]);
      const required=settings[0]?.value||{};
      if(custom.length||Object.entries(required).some(([k,v])=>v===true&&!['dueDate','assignee','reviewer'].includes(k)))throw new TaskWorkError('work_required_fields');
      return {task:card,required};
    },
    async dependencies(actor,query){
      const db=dbFor(factory,actor),text=String(query||'').replace(/[^\p{L}\p{N} _-]/gu,'').trim().slice(0,100),filter=`*${text}*`;
      return (await db.rows('tasks',{select:'id,task_key,title,projects!inner(id,is_archived)',...active,or:`(task_key.ilike.${filter},title.ilike.${filter})`,order:'task_key.asc,id.asc',limit:'20'}))
        .map(t=>({text:{type:'plain_text',text:`${t.task_key} · ${t.title}`.slice(0,75)},value:identifier(t.id)}));
    },
    async command(actor,input){const command=parseTaskWorkCommand(input),db=dbFor(factory,actor);await task(db,command.taskId);
      if(command.operation==='add_dependency')await task(db,command.dependsOnTaskId);
      return execute(actor,command);},
  };
}
/** The endpoint revalidates this same short-lived member bearer with GoTrue. */
export async function executeSlackWorkCommand(env:{get(name:string):string|undefined},actor:Row,input:TaskWorkCommand,fetcher:typeof fetch=fetch):Promise<TaskWorkResult> {
  if(!actor.jwt)throw new TaskWorkError('work_forbidden',403);
  try {
    const response=await fetcher(`${env.get('SUPABASE_URL')?.replace(/\/$/,'')}/functions/v1/task-work-command`,{method:'POST',
      headers:{apikey:env.get('SUPABASE_ANON_KEY')||'',Authorization:`Bearer ${actor.jwt}`,'Content-Type':'application/json'},
      body:JSON.stringify(parseTaskWorkCommand(input)),signal:AbortSignal.timeout(22000)});
    const body=await response.json().catch(():null=>null);
    if(!response.ok||body?.error){const code=typeof body?.error==='string'&&Object.prototype.hasOwnProperty.call(TASK_WORK_ERRORS,body.error)?body.error:'work_unavailable';throw new TaskWorkError(code,response.status>=500?503:TASK_WORK_ERRORS[code]||503);}
    if(body?.commandId!==input.commandId||body?.task?.id!==input.taskId)throw new TaskWorkError('work_unavailable',503);
    return body;
  } catch(error){if(error instanceof TaskWorkError)throw error;throw new TaskWorkError('work_unavailable',503);}
}
