import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client',()=>({supabase:{auth:{getSession:vi.fn(async()=>({data:{session:{access_token:'synthetic-session'}}}))}}}));
import { taskCommentClient, uploadTaskCommentFile, type TaskCommentResume } from '@/lib/taskCommentClient';
const id='10000000-0000-4000-8000-000000000001';
const attachment={id,taskId:'task-example',fileName:'example.png',mimeType:'image/png',size:8};
const file=()=>new File([new Uint8Array([137,80,78,71,13,10,26,10])],'example.png',{type:'image/png'});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
describe('task provider upload acknowledgement recovery',()=>{
  const fetchMock=vi.fn();
  beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('fetch',fetchMock);});
  afterEach(()=>vi.unstubAllGlobals());
  it('reconciles a lost complete response without uploading the accepted part again',async()=>{
    fetchMock.mockResolvedValueOnce(response({error:{code:'upload_unavailable'}},404))
      .mockResolvedValueOnce(response({id,provider:'r2',partSize:5242880}))
      .mockResolvedValueOnce(response({partNumber:1,etag:'synthetic-etag'}))
      .mockRejectedValueOnce(new TypeError('lost_complete_response'))
      .mockResolvedValueOnce(response(attachment));
    const resume:TaskCommentResume={id},f=file();
    await expect(uploadTaskCommentFile('task-example',f,resume,vi.fn())).rejects.toThrow('lost_complete_response');
    expect(resume.parts).toHaveLength(1);
    expect(await uploadTaskCommentFile('task-example',f,resume,vi.fn())).toEqual(attachment);
    expect(fetchMock.mock.calls.filter(([url])=>String(url).includes('upload_part'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([,init])=>typeof init.body==='string'&&JSON.parse(init.body).action==='upload_init')).toHaveLength(1);
  });
  it('retains the original reservation ID when its init acknowledgement is lost',async()=>{
    fetchMock.mockResolvedValueOnce(response({error:{code:'upload_unavailable'}},404)).mockRejectedValueOnce(new TypeError('lost_init'))
      .mockResolvedValueOnce(response({error:{code:'upload_incomplete'}},409)).mockResolvedValueOnce(response({id,provider:'r2'}))
      .mockResolvedValueOnce(response({etag:'synthetic-etag'})).mockResolvedValueOnce(response(attachment));
    const resume:TaskCommentResume={id},f=file();
    await expect(uploadTaskCommentFile('task-example',f,resume,vi.fn())).rejects.toThrow('lost_init');
    await uploadTaskCommentFile('task-example',f,resume,vi.fn());
    const inits=fetchMock.mock.calls.filter(([,init])=>typeof init.body==='string'&&JSON.parse(init.body).action==='upload_init');
    expect(inits.map(([,init])=>JSON.parse(init.body).uploadId)).toEqual([id,id]);
  });
  it('never adopts another draft file or another task',async()=>{
    const f=file();await expect(uploadTaskCommentFile('other-task',f,{taskId:'task-example',file:f},vi.fn())).rejects.toThrow('upload_context_changed');expect(fetchMock).not.toHaveBeenCalled();
  });
  it('aborts before fetching or allocating a reservation',async()=>{
    const controller=new AbortController();controller.abort();await expect(uploadTaskCommentFile('task-example',file(),{},vi.fn(),controller.signal)).rejects.toBeDefined();expect(fetchMock).not.toHaveBeenCalled();
  });
  it('batches card summaries instead of issuing one request per card',async()=>{
    const ids=Array.from({length:1201},(_,n)=>'task-'+n);
    fetchMock.mockImplementation(async(_url,init)=>{const body=JSON.parse(init.body);return response({workspaceId:'ws',actorId:'actor',counts:Object.fromEntries(body.taskIds.map((id:string)=>[id,2])),commentCounts:Object.fromEntries(body.taskIds.map((id:string)=>[id,1])),storageUsedBytes:200,storageUsageSource:'workspace_quota'});});
    const result=await taskCommentClient.summary(ids);expect(fetchMock).toHaveBeenCalledTimes(2);expect(Object.keys(result.counts)).toHaveLength(1201);
    expect(fetchMock.mock.calls.every(([,init])=>init.cache==='no-store')).toBe(true);
  });
  it('rejects foreign task counts and identity changes rather than publishing a misleading zero',async()=>{
    fetchMock.mockResolvedValueOnce(response({workspaceId:'ws',actorId:'actor',counts:{hidden:2},commentCounts:{},storageUsedBytes:1,storageUsageSource:'workspace_quota'}));
    await expect(taskCommentClient.summary(['task-a'])).rejects.toThrow('summary_unavailable');
    fetchMock.mockImplementation(async(_url,init)=>{const body=JSON.parse(init.body);return response({workspaceId:body.taskIds[0]==='task-0'?'ws':'different',actorId:'actor',counts:{},commentCounts:{},storageUsedBytes:1,storageUsageSource:'workspace_quota'});});
    await expect(taskCommentClient.summary(Array.from({length:1001},(_,n)=>'task-'+n))).rejects.toThrow('summary_scope_changed');
  });

});
