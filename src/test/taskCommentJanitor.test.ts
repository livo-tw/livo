// @vitest-environment node
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { runTaskCommentUploadCleanup } from '../../docker/volumes/functions/qa-upload-cleanup/taskCommentCleanup';
function client(count=1){
  const remove=vi.fn(async()=>({data:[],error:null}));
  const rpc=vi.fn(async(name:string,input:any):Promise<any>=>{
    if(name==='livo_task_comment_cleanup_claim')return{error:null,data:Array.from({length:count},(_,n)=>({workspace_id:'default',id:`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,task_id:'task-example',storage_key:`default/task-example/10000000-0000-4000-8000-${String(n).padStart(12,'0')}`,cleanup_token:input.p_token}))};
    return{error:null,data:true};
  });
  return{rpc,remove,storage:{from:vi.fn(()=>({remove}))}};
}
describe('private task files use the real existing service-only janitor entry',()=>{
  it('checks the claimed owner before deletion and requires database ACK afterwards',async()=>{
    const store=client();expect(await runTaskCommentUploadCleanup(store)).toEqual({claimed:1,removed:1,retained:0,failed:0});
    expect(store.storage.from).toHaveBeenCalledWith('task-comment-media');expect(store.rpc.mock.calls.map(call=>call[0])).toEqual(['livo_task_comment_cleanup_claim','livo_task_comment_cleanup_owns','livo_task_comment_cleanup_ack']);
  });
  it('keeps the claim when storage deletion fails, without issuing a success ACK',async()=>{
    const store=client();store.remove.mockResolvedValue({data:[],error:new Error('delete failed')} as any);
    expect(await runTaskCommentUploadCleanup(store)).toMatchObject({removed:0,failed:1,retained:1});expect(store.rpc.mock.calls.some(call=>call[0]==='livo_task_comment_cleanup_ack')).toBe(false);
  });
  it('never deletes a lost claim or a path belonging to another namespace',async()=>{
    const store=client();store.rpc.mockImplementation(async(name,input)=>name==='livo_task_comment_cleanup_claim'?{error:null,data:[{workspace_id:'other',id:'example',task_id:'task-example',storage_key:'other/private',cleanup_token:input.p_token}]}:{error:null,data:false});
    expect(await runTaskCommentUploadCleanup(store)).toMatchObject({removed:0,retained:1});expect(store.remove).not.toHaveBeenCalled();
  });
  it('executes the unchanged service credential gate before any client or cleanup, including personal super-admin JWTs',async()=>{
    const source=readFileSync(new URL('../../docker/volumes/functions/qa-upload-cleanup/index.ts',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
    const js=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
    let handler:(request:Request)=>Promise<Response>=async()=>new Response();const create=vi.fn(()=>client(4)),qa=vi.fn(async(_repository,limit)=>({claimed:limit,removed:limit,retained:0,failed:0}));
    const Deno={env:{get:(name:string)=>name==='SUPABASE_SERVICE_ROLE_KEY'?'synthetic-service-key':'https://example.com'},serve:(value:typeof handler)=>{handler=value;}};
    new Function('Deno','createClient','runQaUploadCleanup','runTaskCommentUploadCleanup',js)(Deno,create,qa,runTaskCommentUploadCleanup);
    const forbidden=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer synthetic-personal-super-admin-jwt'}}));expect(forbidden.status).toBe(403);expect(create).not.toHaveBeenCalled();
    const allowed=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer synthetic-service-key'}}));expect(allowed.status).toBe(200);expect(qa.mock.calls[0][1]).toBe(21);expect(await allowed.json()).toMatchObject({claimed:25,task:{claimed:4},qa:{claimed:21}});
  });
});
