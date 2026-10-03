import { supabase, USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import { randomUUID } from '@/lib/generateId';
import { applyReleaseCommand, canonicalReleaseJson, parseReleaseCommand, parseReleaseRequest, validReleaseResponse, ReleaseError, RELEASE_ERROR_STATUS,
  type ReleaseBatch, type ReleaseCommand, type ReleaseContext, type ReleaseEvent, type ReleaseEventPage, type ReleasePage, type ReleaseRequest, type ReleaseResult } from './core';
type WithoutId<T> = T extends unknown ? Omit<T, 'commandId'> : never;
export type ReleaseIntent = WithoutId<ReleaseCommand>;
type Store = { batches: Map<string, ReleaseBatch>; commands: Map<string, { actorId: string; payload: string; result: ReleaseResult }>; events: (ReleaseEvent & { workspaceId: string })[] };
const demo: Store = { batches: new Map(), commands: new Map(), events: [] };
export interface ReleaseClientOptions { context: () => ReleaseContext; mock?: boolean }
/** Demo state is isolated from all persisted task/QA tables and uses the same parser/domain. */
export function createReleaseClient(options: ReleaseClientOptions) {
  const pending = new Map<string, ReleaseCommand>(), flights = new Map<string, Promise<ReleaseResult>>();
  const request = async <T>(input: ReleaseRequest): Promise<T> => {
    const p = parseReleaseRequest(input);
    if (options.mock ?? USING_MOCK_BACKEND) {
      const ctx = options.context(), key = (id: string) => `${ctx.workspaceId}:${id}`;
      if (!ctx.memberIds.has(ctx.actorId)) throw new ReleaseError('release_forbidden', 403);
      const visible = (b: ReleaseBatch) => b.workspaceId === ctx.workspaceId && b.components.every(c => (ctx.visibleProjectIds??ctx.projectIds).has(c.projectId) && c.taskIds.every(id => ctx.taskProjects.get(id) === c.projectId));
      const get = (id: string) => { const b = demo.batches.get(key(id)); if (!b || !visible(b)) throw new ReleaseError('release_not_found', 404); return b; };
      let result: unknown;
      if (p.action === 'get') result = get(p.batchId);
      else if(p.action==='receipt'){if(!['admin','super_admin'].includes(ctx.role))throw new ReleaseError('release_forbidden',403);const r=demo.commands.get(key(p.commandId));if(r&&(r.actorId!==ctx.actorId||r.result.batch.id!==p.batchId))throw new ReleaseError('release_forbidden',403);result=r?{found:true,result:{...r.result,replayed:true,batch:get(p.batchId)}}:{found:false};}
      else if (p.action === 'events') { get(p.batchId); const events = demo.events.filter(e => e.batchId === p.batchId && e.workspaceId === ctx.workspaceId).sort((a,b) => b.version-a.version); result = { events: events.slice(p.page*8,p.page*8+8), page: p.page, hasMore: events.length>p.page*8+8 }; }
      else if (p.action === 'list') { const batches = [...demo.batches.values()].filter(b => visible(b) && (!p.projectId || b.components.some(c => c.projectId === p.projectId)) && (!p.search || b.title.toLowerCase().includes(p.search.toLowerCase()))).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id)); result = { batches: batches.slice(p.page*8,p.page*8+8), page: p.page, hasMore: batches.length>p.page*8+8 }; }
      else {
        const c = p.command, payload = canonicalReleaseJson(c), previous = demo.commands.get(key(c.commandId));
        if (!['admin','super_admin'].includes(ctx.role)) throw new ReleaseError('release_forbidden',403);
        if (previous) { if (previous.actorId !== ctx.actorId || previous.payload !== payload) throw new ReleaseError('release_command_reused',409); result = {...previous.result,replayed:true,batch:get(c.batchId)}; }
        else { const before = c.operation === 'create' ? demo.batches.get(key(c.batchId)) ?? null : get(c.batchId), batch = applyReleaseCommand(before,c,ctx);
          const event: ReleaseEvent = {id:ctx.newId(),batchId:batch.id,actorId:ctx.actorId,operation:c.operation,version:batch.version,revision:batch.manifestRevision,createdAt:ctx.now};
          const value: ReleaseResult = {commandId:c.commandId,replayed:false,batch,event}; demo.batches.set(key(batch.id),batch); demo.events.push({...event,workspaceId:ctx.workspaceId}); demo.commands.set(key(c.commandId),{actorId:ctx.actorId,payload,result:value}); result=value; }
      }
      return structuredClone(result) as T;
    }
    for (let attempt=0;attempt<2;attempt++) {
      try {
        const {data,error}=await supabase.functions.invoke('release-workspace',{body:p});
        let code=typeof data?.error==='string'?data.error:null;
        if (!code && error && 'context' in error && error.context instanceof Response) { const body=await error.context.clone().json().catch(():null=>null);code=body?.error; }
        if(code && Object.prototype.hasOwnProperty.call(RELEASE_ERROR_STATUS,code) && code!=='release_unavailable')throw new ReleaseError(code,RELEASE_ERROR_STATUS[code]);
        if(error||code||data==null)throw new Error('transport');
        if(!validReleaseResponse(p,data))throw new Error('invalid_response');
        return data as T;
      }catch(error){if(error instanceof ReleaseError)throw error;if(attempt===1)throw new ReleaseError('release_transport_error',503);}
    }
    throw new ReleaseError('release_transport_error',503);
  };
  return {
    list: (page=0, projectId?:string, search?:string) => request<ReleasePage>({action:'list',page,...(projectId?{projectId}:{}),...(search?.trim()?{search:search.trim()}:{})}),
    get: (batchId:string) => request<ReleaseBatch>({action:'get',batchId}),
    events: (batchId:string,page=0) => request<ReleaseEventPage>({action:'events',batchId,page}),
    execute(intent:ReleaseIntent):Promise<ReleaseResult>{
      const key=canonicalReleaseJson({...intent,commandId:'placeholder'}),existing=flights.get(key);if(existing)return existing;
      const command=pending.get(key)??parseReleaseCommand({...intent,commandId:randomUUID()});pending.set(key,command);
      const flight=request<ReleaseResult>({action:'command',command}).then(result=>{pending.delete(key);return result;},error=>{if(!(error instanceof ReleaseError)||error.code!=='release_transport_error')pending.delete(key);throw error;}).finally(()=>flights.delete(key));
      flights.set(key,flight);return flight;
    },
  };
}
