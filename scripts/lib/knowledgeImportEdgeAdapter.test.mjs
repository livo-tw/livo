// @vitest-environment node
import { describe,it,expect,vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

describe('private import edge adapter contract',()=>{
  it('connects duplicate lookup, commit recovery and expiry cleanup using the verified auth binding',async()=>{
    const calls=[];let handler,repository;
    const query={select(){return this;},eq(){return this;},async maybeSingle(){return {data:{id:'member-fixture',role:'member',is_active:true},error:null};}};
    const client={auth:{getUser:async()=>({data:{user:{id:'auth-fixture'}},error:null})},from:()=>query,rpc:async(name,args)=>{calls.push({name,...args});return {data:[],error:null};}};
    const canonical=fs.readFileSync(path.resolve(__dirname,'../../docker/volumes/functions/knowledge-import/index.ts'),'utf8');
    const mirrorPath=path.resolve(__dirname,'../../supabase/functions/knowledge-import/index.ts');
    // The official OSS export intentionally omits the private Supabase mirror.
    if(fs.existsSync(mirrorPath))expect(fs.readFileSync(mirrorPath,'utf8')).toBe(canonical);
    const js=transformSync(canonical.replace(/^import .*;\r?\n/gm,''),{loader:'ts',format:'cjs'}).code;
    class ImportError extends Error{}
    new Function('createClient','createKnowledgeImport','ImportError','Deno','EdgeRuntime',js)(()=>client,repo=>{repository=repo;return async()=>({ok:true});},ImportError,{env:{get:()=>undefined},serve:fn=>{handler=fn;}},{waitUntil:vi.fn()});
    const response=await handler(new Request('http://local/knowledge-import',{method:'POST',headers:{Authorization:'Bearer example'},body:'{}'}));
    expect(response.status).toBe(200);
    await repository.findSources(['file:a'],'parent','project');await repository.results('job');await repository.expiredJobs();await repository.deleteExpiredJob('old-job');
    expect(calls.map(x=>x.p_action)).toEqual(['find_sources','results','expired','delete_expired']);
    expect(calls.every(x=>x.p_actor==='member-fixture'&&x.p_payload.auth_id==='auth-fixture')).toBe(true);
    expect(calls[0].p_payload).toEqual({keys:['file:a'],parent:'parent',project:'project',auth_id:'auth-fixture'});
  });
});
