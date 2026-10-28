import type { Context } from 'hono';
import type { AppContext, AuthCtx, Env } from './env';
import { commandAuthId, liveMember, liveMemberSql } from './liveMember';
import { qaReadBody } from './qa';
import { notifyChanges } from './notify';
import { withFullTaskRows } from './taskEvents';
import { rowToWire } from './meta';
import { TABLES } from './tables';
import type { ChangeEvent } from './protocol';

export type SprintCommand =
 | {commandId:string;operation:'start';sprintId:string;name:string;taskIds:string[];includeBacklog:boolean}
 | {commandId:string;operation:'complete';sprintId:string;expectedVersion:number};
export type SprintResult = {sprintId:string;version:number;completedCount:number;cancelledCount:number;pendingCount:number;pendingIds:string[];taskIds:string[];carryIds:string[];replayed?:boolean};
const statuses:Record<string,number>={sprint_invalid_input:400,sprint_unauthorized:401,sprint_forbidden:403,sprint_conflict:409,sprint_command_reused:409,sprint_not_found:404};
export class SprintError extends Error {
 constructor(public code:string,public status:number=statuses[code]||500){super(code);}
}
export function sprintError(error:unknown):SprintError {
 if(error instanceof SprintError)return error;
 const message=error instanceof Error?error.message:String(error);
 for(const code of Object.keys(statuses))if(message.includes(code))return new SprintError(code);
 if(/SQLITE_BUSY|SQLITE_LOCKED|database is locked|UNIQUE constraint failed/i.test(message))return new SprintError('sprint_conflict');
 return new SprintError('sprint_unknown',503);
}
const invalid=():never=>{throw new SprintError('sprint_invalid_input');};
const uuid=(value:unknown):string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():invalid();
export function parseSprintCommand(input:unknown):SprintCommand {
 if(!input||typeof input!=='object'||Array.isArray(input))return invalid();
 const c=input as Record<string,unknown>,keys=c.operation==='start'?['commandId','operation','sprintId','name','taskIds','includeBacklog']:['commandId','operation','sprintId','expectedVersion'];
 if(Object.keys(c).length!==keys.length||Object.keys(c).some(k=>!keys.includes(k)))return invalid();
 const commandId=uuid(c.commandId);
 const sprintId=c.operation==='start'?uuid(c.sprintId):typeof c.sprintId==='string'&&c.sprintId.length>0&&c.sprintId.length<=200&&c.sprintId.trim()===c.sprintId?(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(c.sprintId)?c.sprintId.toLowerCase():c.sprintId):invalid();
 if(c.operation==='start'){
  if(typeof c.name!=='string'||!c.name.trim()||c.name.trim().length>120||typeof c.includeBacklog!=='boolean'||!Array.isArray(c.taskIds)||c.taskIds.length>2000)return invalid();
  if(c.taskIds.some(v=>typeof v!=='string'||!v||v.trim()!==v||v.length>200))return invalid();
  return {commandId,operation:'start',sprintId,name:c.name.trim(),taskIds:[...new Set(c.taskIds as string[])].sort(),includeBacklog:c.includeBacklog};
 }
 if(c.operation!=='complete'||!Number.isSafeInteger(c.expectedVersion)||(c.expectedVersion as number)<0)return invalid();
 return {commandId,operation:'complete',sprintId,expectedVersion:c.expectedVersion as number};
}
type Receipt={actor_id:string;sprint_id:string;command:string;result_json:string};
const receipt=(env:Env,ws:string,id:string)=>env.DB.prepare('SELECT actor_id,sprint_id,command,result_json FROM sprint_command_receipts WHERE workspace_id=? AND id=?').bind(ws,id).first<Receipt>();
export async function executeSprintCommand(env:Env,auth:AuthCtx,input:unknown):Promise<SprintResult>{
 const command=parseSprintCommand(input),canonical=JSON.stringify(command),ws=auth.member.workspaceId;
 if(!await liveMember(env,auth,{strict:true}))throw new SprintError('sprint_forbidden');
 const authId=await commandAuthId(env,auth);if(!authId)throw new SprintError('sprint_forbidden');
 const replay=(prior:Receipt):SprintResult=>{
  if(prior.actor_id!==auth.member.id||prior.sprint_id!==command.sprintId||prior.command!==canonical)throw new SprintError('sprint_command_reused');
  return {...JSON.parse(prior.result_json),replayed:true};
 };
 const prior=await receipt(env,ws,command.commandId);if(prior)return replay(prior);
 try{
  await env.DB.prepare('INSERT INTO sprint_command_contexts(workspace_id,id,auth_id,actor_id,operation,sprint_id,command,created_at) VALUES(?,?,?,?,?,?,?,?)')
   .bind(ws,command.commandId,authId,auth.member.id,command.operation,command.sprintId,canonical,new Date().toISOString()).run();
 }catch(error){const raced=await receipt(env,ws,command.commandId);if(raced)return replay(raced);throw sprintError(error);}
 const saved=await receipt(env,ws,command.commandId);if(!saved)throw new SprintError('sprint_unknown',503);
 return {...JSON.parse(saved.result_json),replayed:false};
}
export function sprintGenericPatch(table:string,value:Record<string,unknown>){
 if(table!=='sprints')return value;
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>k!=='name'))throw new SprintError('sprint_forbidden');
 if(typeof value.name!=='string'||!value.name.trim()||value.name.trim().length>120)throw new SprintError('sprint_invalid_input');
 return {name:value.name.trim()};
}
export function sprintHistoryReadScope(auth:AuthCtx):{sql:string;params:string[]}{
 const member=liveMemberSql(auth,'sprint_reader',{strict:true});
 return {sql:`EXISTS(SELECT 1 FROM members sprint_reader WHERE ${member.sql}) AND EXISTS(SELECT 1 FROM projects sprint_project WHERE sprint_project.workspace_id=sprint_task_history.workspace_id AND sprint_project.id=sprint_task_history.project_id)`,params:member.params};
}
export async function sprintReadback(env:Env,table:string,ws:string,rows:Record<string,unknown>[]){
 if(table!=='sprints'||!rows.length)return rows;
 const result:Record<string,unknown>[]=[];
 for(const row of rows){const current=await env.DB.prepare('SELECT * FROM sprints WHERE workspace_id=? AND id=?').bind(ws,String(row.id)).first<Record<string,unknown>>();result.push(current||row);}
 return result;
}
export async function handleSprintRpc(c:Context<AppContext>):Promise<Response>{
 try{
  const body=JSON.parse(new TextDecoder().decode(await qaReadBody(c,1024*1024)));
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||!Object.prototype.hasOwnProperty.call(body,'p_command'))throw new SprintError('sprint_invalid_input');
  const command=parseSprintCommand(body.p_command),auth=c.get('auth'),result=await executeSprintCommand(c.env,auth,command);
  if(!result.replayed){
   const ws=auth.member.workspaceId;
   const sprint=await c.env.DB.prepare('SELECT * FROM sprints WHERE workspace_id=? AND id=?').bind(ws,result.sprintId).first<Record<string,unknown>>();
   const events:ChangeEvent[]=[{table:'sprints',eventType:command.operation==='start'?'INSERT':'UPDATE',new:sprint?rowToWire(sprint,TABLES.sprints):{id:result.sprintId},old:command.operation==='complete'?{id:result.sprintId}:null},
    ...result.taskIds.map(id=>({table:'tasks',eventType:'UPDATE' as const,new:{id},old:{id}}))];
   const ready:ChangeEvent[]=[];
   // D1 permits 100 bound parameters; each full-row query also binds workspace.
   for(let i=0;i<events.length;i+=90)ready.push(...await withFullTaskRows(c.env,ws,events.slice(i,i+90)));
   notifyChanges(c.env,c.executionCtx,ready,ws);
  }
  return c.json({data:result,error:null});
 }catch(error){const e=error instanceof SyntaxError?new SprintError('sprint_invalid_input'):error instanceof Error&&error.message==='qa_request_too_large'?new SprintError('sprint_invalid_input',413):sprintError(error);return c.json({data:null,error:{message:e.code}},e.status as 400);}
}
