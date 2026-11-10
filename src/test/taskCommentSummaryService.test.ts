// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskCommentService } from '../../docker/volumes/functions/task-comments/service';
const environment={get:(name:string)=>({SUPABASE_URL:'https://example.com',SUPABASE_ANON_KEY:'anon-example',SUPABASE_SERVICE_ROLE_KEY:'service-example'} as Record<string,string>)[name]};
const json=(value:unknown,headers:Record<string,string>={})=>new Response(JSON.stringify(value),{headers});
afterEach(()=>vi.unstubAllGlobals());
describe('task attachment aggregate adapter authorization',()=>{
  it('reads IDs with the caller JWT and passes only RLS-readable IDs to the service aggregate',async()=>{
    const seen: {url:string;init:RequestInit}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{seen.push({url,init});
      if(url.includes('/auth/'))return json({id:'auth-example'});
      if(url.includes('/members?'))return json([{id:'member-example',auth_id:'auth-example',is_active:true,role:'member'}]);
      if(url.includes('/tasks?'))return json([{id:'task-visible'}],{'content-range':'0-0/1'});
      if(url.includes('/rpc/'))return json({counts:{'task-visible':3},commentCounts:{'task-visible':1},storageUsedBytes:8});
      throw Error('unexpected request');
    }));
    const result=await createTaskCommentService(environment,'session-example').handle({action:'summary',taskIds:['task-visible','task-hidden']});
    expect((result as {counts:Record<string,number>}).counts).toEqual({'task-visible':3});
    const task=seen.find(x=>x.url.includes('/tasks?'))!;expect((task.init.headers as Record<string,string>).Authorization).toBe('Bearer session-example');
    const rpc=seen.find(x=>x.url.includes('/rpc/'))!;expect(JSON.parse(String(rpc.init.body)).p_tasks).toEqual(['task-visible']);expect((rpc.init.headers as Record<string,string>).Authorization).toBe('Bearer service-example');
  });
  it.each(['admin','super_admin','member'])('denies an inactive %s before any aggregate read',async(role)=>{
    const fetcher=vi.fn(async(url:string)=>url.includes('/auth/')?json({id:'auth-example'}):json([{id:'member-example',auth_id:'auth-example',is_active:false,role}]));vi.stubGlobal('fetch',fetcher);
    await expect(createTaskCommentService(environment,'session-example').handle({action:'summary',taskIds:[]})).rejects.toThrow('forbidden');expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('denies external/unbound users and service credentials as a personal session',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/auth/')?json({id:'external-example'}):json([])));
    await expect(createTaskCommentService(environment,'session-example').handle({action:'summary',taskIds:[]})).rejects.toThrow('forbidden');
    await expect(createTaskCommentService(environment,'service-example').handle({action:'summary',taskIds:[]})).rejects.toThrow('unauthorized');
  });
  it('bounds large PostgREST URLs and paginates a capped visible result without dropping IDs',async()=>{
    const ids=Array.from({length:1000},(_,n)=>'task-'+String(n).padStart(4,'0')),requests:string[]=[],passed:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
      if(url.includes('/auth/'))return json({id:'auth-example'});
      if(url.includes('/members?'))return json([{id:'member-example',auth_id:'auth-example',is_active:true,role:'member'}]);
      if(url.includes('/tasks?')){requests.push(url);const group=new URL(url).searchParams.get('id')!.slice(4,-1).split(',');const offset=Number((init.headers as Record<string,string>).Range.split('-')[0]);return json(group.slice(offset,offset+7).map(id=>({id})),{'content-range':`${offset}-${Math.min(offset+6,group.length-1)}/${group.length}`});}
      passed.push(...JSON.parse(String(init.body)).p_tasks);return json({});
    }));
    await createTaskCommentService(environment,'session-example').handle({action:'summary',taskIds:ids});expect(passed).toEqual(ids);expect(Math.max(...requests.map(url=>url.length))).toBeLessThan(5200);
  });
});
