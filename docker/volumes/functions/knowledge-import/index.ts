import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { createKnowledgeImport, ImportError, type ImportRepository } from './knowledgeImport.ts';
const headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Content-Type':'application/json','Cache-Control':'no-store'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers});
Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response(null,{headers});
  if(req.method!=='POST')return json({error:'method_not_allowed'},405);
  if(Number(req.headers.get('content-length')||0)>15*1024*1024)return json({error:'file_size_limit'},413);
  try {
    const authorization=req.headers.get('authorization');if(!authorization?.startsWith('Bearer '))return json({error:'unauthorized'},401);
    const token=authorization.slice(7);
    const client=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:auth,error:authError}=await client.auth.getUser(token);if(authError||!auth.user)return json({error:'unauthorized'},401);
    const {data:actor,error:actorError}=await client.from('members').select('id,role,job_title,is_active').eq('auth_id',auth.user.id).eq('is_active',true).maybeSingle();if(actorError||!actor)return json({error:'import_forbidden'},403);
    const db=async(action:string,payload:Record<string,unknown>={})=>{const {data,error}=await client.rpc('knowledge_import_db',{p_action:action,p_actor:actor.id,p_payload:{...payload,auth_id:auth.user.id}});if(error)throw new ImportError(error.message,error.code==='42501'?403:error.code==='40001'?409:400);return data;};
    const repo:ImportRepository={
      actor:()=>db('actor'),pages:()=>db('pages'),policy:()=>db('policy'),
      async savePolicy(policy,expectedVersion){await db('save_policy',{policy,expected:expectedVersion});},
      getJob:id=>db('get',{id}),listJobs:()=>db('list'),saveJob:(job,expected)=>db('save_job',{job,expected}),
      async putFile(key,data,type){const {error}=await client.storage.from('kb-imports').upload(key,data,{contentType:type,upsert:true});if(error)throw new ImportError('staging_failed',503);},
      async getFile(key){const {data,error}=await client.storage.from('kb-imports').download(key);if(error)return null;return new Uint8Array(await data.arrayBuffer());},
      async deleteFile(key){
        const checks=await Promise.all([
          client.from('knowledge_import_sources').select('id').eq('original->>key',key).limit(1),
          client.from('knowledge_import_sources').select('id').contains('assets',[{key}]).limit(1),
        ]);
        if(checks.some(result=>result.error))throw new ImportError('cleanup_failed',503);
        if(checks.some(result=>result.data?.length))return;
        const {error}=await client.storage.from('kb-imports').remove([key]);if(error)throw new ImportError('cleanup_failed',503);
      },
      sources:pageId=>db('sources',{page_id:pageId}),
      findSources:(keys,parent,project)=>db('find_sources',{keys,parent,project}),
      results:jobId=>db('results',{job_id:jobId}),
      expiredJobs:()=>db('expired'),
      async deleteExpiredJob(jobId){await db('delete_expired',{job_id:jobId});},
      commit:(job,item,mapping,source)=>db('commit',{job_id:job.id,job_version:job.version,item_id:item.id,mapping,source}),
      background(promise){EdgeRuntime.waitUntil(promise);},
    };
    const raw=await req.text();if(raw.length>15*1024*1024)return json({error:'file_size_limit'},413);
    const response=await createKnowledgeImport(repo,{processorUrl:Deno.env.get('KNOWLEDGE_PROCESSOR_URL'),processorToken:Deno.env.get('KNOWLEDGE_PROCESSOR_TOKEN'),encryptionSecret:Deno.env.get('KNOWLEDGE_IMPORT_SECRET')})(JSON.parse(raw));
    return json(response);
  } catch(error){return error instanceof ImportError?json({error:error.code},error.status):json({error:'import_failed'},500);}
});
