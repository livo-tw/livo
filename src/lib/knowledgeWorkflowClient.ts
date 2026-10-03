import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { randomUUID } from '@/lib/generateId';
import { KnowledgeWorkflowError, type KnowledgeWorkflowData } from './knowledgeWorkflowDomain';

const demoPages = new Map<string, KnowledgeWorkflowData>();
const demoReceipts = new Map<string, { hash: string; result: unknown }>();
async function demo(request: Record<string, any>): Promise<any> {
  if (request.action === 'backlinks') return {items:[]};
  const pageId = request.pageId;
  const data = demoPages.get(pageId) || { pageVersion: 1, checklist: [], links: [], snapshots: [] };
  demoPages.set(pageId,data);
  if (request.action === 'list') return structuredClone(data);
  if (request.action === 'search_targets') {
    if (request.targetKind === 'qa') return {items:[]};
    const rows = await supabase.from('tasks').select('id,title,task_key,project_id');
    return {items:(rows.data || []).filter(t=>(t.title+' '+t.task_key).toLowerCase().includes(String(request.query||'').toLowerCase())).slice(0,50).map(t=>({id:t.id,title:t.title,key:t.task_key,projectId:t.project_id}))};
  }
  const previous = demoReceipts.get(request.commandId), hash=JSON.stringify(request);
  if(previous){if(previous.hash!==hash)throw new KnowledgeWorkflowError('kb_workflow_idempotency_conflict',409);return previous.result;}
  let result: Record<string,unknown> = {id:randomUUID()};
  const item=data.checklist.find(c=>c.id===request.checklistId);
  if(request.checklistId&&(!item||item.version!==request.expectedVersion||item.linkedWorkId))throw new KnowledgeWorkflowError('kb_workflow_conflict',409);
  if(request.action==='checklist_add')data.checklist.push({id:result.id as string,pageId,anchorId:randomUUID(),text:request.text,isDone:false,version:1,updatedBy:'demo',updatedAt:new Date().toISOString(),completedBy:null,completedAt:null,linkedWorkId:null});
  else if(request.action==='checklist_set'&&item){item.isDone=request.isDone;item.version++;item.updatedAt=new Date().toISOString();item.completedAt=item.isDone?item.updatedAt:null;item.completedBy=item.isDone?'demo':null;result={id:item.id};}
  else if(request.action==='checklist_delete')data.checklist=data.checklist.filter(c=>c.id!==request.checklistId);
  else if(request.action==='unlink'){data.links=data.links.filter(l=>l.id!==request.linkId);data.checklist.forEach(c=>{if(c.linkedWorkId===request.linkId)c.linkedWorkId=null;});}
  else if(request.action==='link'){
    const rows=await supabase.from('tasks').select('*').eq('id',request.targetId).maybeSingle();
    data.links.push({id:result.id as string,pageId,anchorId:item?.anchorId||randomUUID(),checklistId:item?.id||null,snapshotId:null,targetKind:request.targetKind,targetId:request.targetId,relation:request.relation||'reference',title:rows.data?.title||request.targetId,key:rows.data?.task_key||request.targetId,status:'',assigneeId:rows.data?.assignee_id||null,dueDate:rows.data?.due_date||null,unavailable:false});
    if(item)item.linkedWorkId=result.id as string;
  } else if(request.action==='capture_snapshot'){
    const page=await (supabase as any).from('kb_pages').select('*').eq('id',pageId).single();
    data.snapshots.push({id:result.id as string,pageId,sourceKind:'page',sourceTitle:page.data?.title||'',sourceUrl:null,bodyHash:'demo',pageVersion:1,createdAt:new Date().toISOString(),body:page.data?.body||''});
  } else if(request.action==='snapshot')return data.snapshots.find(s=>s.id===request.snapshotId);
  else if(request.action==='create_task'){
    const id=randomUUID(), input=request.input;
    const rows=await supabase.from('tasks').select('task_key').eq('project_id',input.projectId);
    const project=await supabase.from('projects').select('key').eq('id',input.projectId).single();
    const taskKey=`${project.data?.key||'DEMO'}-${1+(rows.data||[]).reduce((max,r)=>Math.max(max,Number(r.task_key.split('-').pop())||0),0)}`;
    const {error}=await supabase.from('tasks').insert({id,task_key:taskKey,project_id:input.projectId,title:input.title,status_id:input.statusId,priority:'medium',creator_id:'demo',assignee_id:input.assigneeId||null,due_date:input.dueDate||null});
    if(error)throw error;
    data.links.push({id:result.id as string,pageId,anchorId:item?.anchorId||randomUUID(),checklistId:item?.id||null,snapshotId:null,targetKind:'task',targetId:id,relation:request.relation||'reference',title:input.title,key:taskKey,status:'',assigneeId:input.assigneeId||null,dueDate:input.dueDate||null,unavailable:false});
    if(item)item.linkedWorkId=result.id as string; result={...result,targetKind:'task',targetId:id};
  } else throw new KnowledgeWorkflowError('kb_workflow_invalid');
  demoReceipts.set(request.commandId,{hash,result});return result;
}

export async function knowledgeWorkflowRequest<T>(request: Record<string, unknown>): Promise<T> {
  if (USING_MOCK_BACKEND) return demo(request) as Promise<T>;
  const {data,error}=await supabase.functions.invoke('knowledge-workflow',{body:request});
  if(error||data?.error){
    let code=data?.error?.code,status:number|undefined;
    if(error&&'context' in error){try{const response=error.context as Response;status=response.status;code??=(await response.clone().json()).error?.code;}catch{/* no structured HTTP response */}}
    // Unknown transport outcomes must retain the idempotency key and frozen form.
    // A lost response can follow a committed task, so it is never a validation error.
    const fallback=code?.includes('conflict')?409:code?.includes('forbidden')?403:code?.includes('invalid')?400:code?.includes('too_large')?413:error?503:400;
    throw new KnowledgeWorkflowError(code||'kb_workflow_unavailable',status||fallback);
  }
  return data as T;
}
