// @vitest-environment node
import { describe,expect,it } from 'vitest';
import { createKnowledgeImport,defaultImportPolicy,ImportError,allowedNotionAsset,notionPageId,importAllowed, type ImportJob,type ImportRepository,type ImportPolicy,type ImportPage,type ImportStoredSource } from '../../worker/src/knowledgeImport';
import type { KnowledgeActor,KnowledgeRule } from '../../worker/src/knowledgeAccess';
import type { ImportDestination } from '../../worker/src/knowledgeImport';
const rule:KnowledgeRule={roles:[],positions:['PM'],member_ids:[]};
const privatePage:ImportPage={id:'pm-page',parent_id:null,project_id:null,title:'Private plan',body:'<p>Human edits</p>',version:4,access_policy:{mode:'custom',view:rule,edit:rule,comment:rule}};
const destination:ImportDestination={parent_id:'pm-page',project_id:null,category:'meeting',policy:{mode:'inherit'},target_id:null,expected_version:null,mode:'create'};
function harness() {
  let actor:KnowledgeActor={id:'member-1',role:'member',job_title:'PM',is_active:true};let policy:ImportPolicy={...defaultImportPolicy(),version:1,subjects:rule};
  const jobs=new Map<string,ImportJob>(),files=new Map<string,Uint8Array>(),sources:ImportStoredSource[]=[],background:Promise<unknown>[]=[];let commits=0,clock=Date.now();
  const repo:ImportRepository={actor:async()=>actor,policy:async()=>policy,pages:async()=>[privatePage],savePolicy:async(next,expected)=>{if(policy.version!==expected)throw new ImportError('policy_changed');policy=next;},getJob:async id=>jobs.get(id)?structuredClone(jobs.get(id)!):null,listJobs:async()=>[...jobs.values()].map(x=>structuredClone(x)),saveJob:async(job,expected)=>{if(expected!==null&&jobs.get(job.id)?.version!==expected)return false;jobs.set(job.id,structuredClone(job));return true;},putFile:async(key,bytes)=>{files.set(key,bytes);},getFile:async key=>files.get(key)||null,deleteFile:async key=>{files.delete(key);},sources:async page=>sources.filter(s=>s.page_id===page),findSources:async()=>[],results:async()=>[],expiredJobs:async()=>[],deleteExpiredJob:async()=>{},commit:async(_job,item,mapping,source)=>{commits++;expect(item.parsed?.body).toContain('Document');expect(mapping.reviewed).toBe(true);sources.push(source);return {page_id:source.page_id,snapshot_id:source.snapshot_id};},background(p){background.push(p);}};
  let transport:typeof fetch=async()=>new Response(JSON.stringify({result:{body:'<p>Document</p>',warnings:[],pages:[],assets:[],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}}),{status:200,headers:{'content-type':'application/json'}});
  const execute=createKnowledgeImport(repo,{processorUrl:'http://private-processor:8091',processorToken:'test-token-'.repeat(4),encryptionSecret:'test-encryption-secret-'.repeat(3),fetcher:(input,init)=>transport(input,init),now:()=>clock});
  const start=async()=>{const job=await execute({action:'start',source:'md',name:'meeting.md',data:btoa('# Document'),parent_id:'pm-page'}) as ImportJob;await Promise.all(background);return await execute({action:'get',job_id:job.id}) as ImportJob;};
  return {execute,start,jobs,repo,files,background,commits:()=>commits,setActor:(a:KnowledgeActor)=>{actor=a;},setPolicy:(p:ImportPolicy)=>{policy=p;},expire:()=>{clock+=25*3600000;},advance:(ms:number)=>{clock+=ms;},setTransport:(next:typeof fetch)=>{transport=next;}};
}
describe('private knowledge imports',()=>{
  it('persists the retention identity before storing the first private object',async()=>{
    const h=harness(),write=h.repo.putFile;let writes=0;
    h.repo.putFile=async(key,data,type)=>{expect(h.jobs.has(key.split('/')[1])).toBe(true);writes++;await write(key,data,type);};
    await h.start();expect(writes).toBe(1);
    const tasks=h.background.length;h.repo.expiredJobs=async()=>{throw new Error('User reads must not run maintenance');};
    await h.execute({action:'list'});expect(h.background.length).toBe(tasks);
  });
  it('does not upload when job persistence fails and removes a write completed after expiry',async()=>{
    const rejected=harness();rejected.repo.saveJob=async()=>false;
    await expect(rejected.start()).rejects.toThrow('job_changed');expect(rejected.files.size).toBe(0);
    const late=harness(),write=late.repo.putFile;
    late.repo.putFile=async(key,data,type)=>{await write(key,data,type);late.expire();};
    await expect(late.start()).rejects.toThrow('preview_expired');expect(late.files.size).toBe(0);expect(late.jobs.size).toBe(1);
  });
  it('reports multibyte converted bodies exceeding the UTF-8 byte cap',async()=>{
    const h=harness();h.setTransport(async()=>new Response(JSON.stringify({result:{body:'字'.repeat(300001),warnings:[],pages:[],assets:[],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}})));
    const job=await h.start();expect(job.status).toBe('failed');expect(job.items[0].error).toBe('parsed_document_too_large');expect(h.commits()).toBe(0);
  });
  it('caps the streamed processor response before JSON parsing even without Content-Length',async()=>{
    const h=harness();let cancelled=false;
    h.setTransport(async()=>new Response(new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1024*1024));},cancel(){cancelled=true;}})));
    const job=await h.start();expect(job.status).toBe('failed');expect(job.items[0].error).toBe('parsed_document_too_large');expect(cancelled).toBe(true);expect(h.commits()).toBe(0);
  });
  it('a superseded parser cannot overwrite a retry that has already committed',async()=>{
    const h=harness();let finishOld!:(response:Response)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
    h.setTransport(async()=>{started();return new Promise<Response>(resolve=>{finishOld=resolve;});});
    const uploaded=await h.execute({action:'start',source:'md',name:'meeting.md',data:btoa('# Document'),parent_id:'pm-page'}) as ImportJob;await began;const oldTask=h.background[0];
    h.advance(181000);const recovered=await h.execute({action:'get',job_id:uploaded.id}) as ImportJob;expect(recovered.status).toBe('failed');
    h.setTransport(async()=>new Response(JSON.stringify({result:{body:'<p>Document New</p>',warnings:[],pages:[],assets:[],hash:'b'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}})));
    const attempts=await Promise.allSettled([h.execute({action:'retry',job_id:uploaded.id}),h.execute({action:'retry',job_id:uploaded.id})]);expect(attempts.some(x=>x.status==='fulfilled')).toBe(true);
    await Promise.all(h.background.slice(1));const ready=await h.execute({action:'get',job_id:uploaded.id}) as ImportJob;expect(ready.items[0].parsed?.body).toContain('New');
    const committed=await h.execute({action:'commit',job_id:ready.id,version:ready.version,mappings:[{item_id:ready.items[0].id,destination,reviewed:true,confirm_audience:true}]}) as ImportJob;expect(committed.status).toBe('succeeded');
    finishOld(new Response(JSON.stringify({result:{body:'<p>Document Old</p>',warnings:[],pages:[],assets:[{name:'old.png',type:'image/png',data:btoa('old')}],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}})));await oldTask;
    const final=await h.execute({action:'get',job_id:ready.id}) as ImportJob;expect(final.status).toBe('succeeded');expect(final.version).toBe(committed.version);expect(final.items[0].parsed?.body).toContain('New');expect(h.files.size).toBe(1);expect(h.commits()).toBe(1);
  });
  it('retry does not reopen an already committed incomplete source or mutate its files',async()=>{
    const h=harness(),job=await h.start();job.status='partially_failed';job.items[0].status='committed';job.items[0].parsed!.incomplete=true;job.items.push({...structuredClone(job.items[0]),id:'failed-item',status:'failed',parsed:undefined});h.jobs.set(job.id,job);
    await h.execute({action:'retry',job_id:job.id});await Promise.all(h.background);const value=await h.execute({action:'get',job_id:job.id}) as ImportJob;expect(value.items[0].status).toBe('committed');expect(value.items[0].original.key).toBe(job.items[0].original.key);
  });
  it('uses a server-encrypted Notion connection and never returns its token',async()=>{
    const h=harness(),page='a'.repeat(32),token='test-notion-token-not-a-real-secret';h.setActor({id:'highest',role:'super_admin',is_active:true});h.setPolicy(defaultImportPolicy());
    const saved=await h.execute({action:'save_policy',version:0,subjects:rule,notion_subjects:rule,notion_pages:[page],notion_token:token}) as Record<string,unknown>;expect(saved.notion_configured).toBe(true);expect(saved.notion_secret).toBeUndefined();expect(JSON.stringify(saved)).not.toContain(token);expect((await h.repo.policy()).notion_secret).not.toContain(token);
    h.setActor({id:'member-1',role:'member',job_title:'PM',is_active:true});const requests:string[]=[];
    h.setTransport(async(input,init)=>{const url=String(input);requests.push(url);expect(init?.redirect).toBe('error');if(url.includes('private-processor'))return new Response(JSON.stringify({result:{body:'<p>Document from Notion</p>',warnings:[],pages:[],assets:[],hash:'a'.repeat(64),parser_version:'test',incomplete:false,needs_review:false}}));expect(url.startsWith('https://api.notion.com/v1/pages/')).toBe(true);return new Response(JSON.stringify(url.endsWith('/markdown')?{markdown:'# Notion Document',truncated:false,unknown_block_ids:[]}:{properties:{Name:{type:'title',title:[{plain_text:'Notion Document'}]}}}));});
    const created=await h.execute({action:'start',source:'notion',page_ids:[page],parent_id:'pm-page'}) as ImportJob;await Promise.all(h.background);const ready=await h.execute({action:'get',job_id:created.id}) as ImportJob;expect(ready.status).toBe('preview_ready');expect(ready.items[0].parsed?.warnings).toContain('notion_layout_review');expect(requests).toHaveLength(3);
  });
  it('grants by live role, position or person; ordinary admin has no implicit import',()=>{expect(importAllowed(defaultImportPolicy(),{id:'a',role:'admin'})).toBe(false);expect(importAllowed(defaultImportPolicy(),{id:'s',role:'super_admin'})).toBe(true);expect(importAllowed({...defaultImportPolicy(),subjects:rule},{id:'p',role:'member',job_title:'PM'})).toBe(true);expect(importAllowed({...defaultImportPolicy(),subjects:{roles:[],positions:[],member_ids:['p']}},{id:'p',role:'member',is_active:false})).toBe(false);});
  it('keeps parsing private until explicit review and destination confirmation',async()=>{const h=harness(),job=await h.start();expect(job.status).toBe('preview_ready');expect(h.commits()).toBe(0);expect(h.files.size).toBe(1);await expect(h.execute({action:'commit',job_id:job.id,version:job.version,mappings:[{item_id:job.items[0].id,destination,reviewed:false,confirm_audience:true}]})).rejects.toThrow('review_required');});
  it('commits the server-held preview, not an arbitrary client body',async()=>{const h=harness(),job=await h.start();const result=await h.execute({action:'commit',job_id:job.id,version:job.version,body:'<script>evil</script>',mappings:[{item_id:job.items[0].id,destination,reviewed:true,confirm_audience:true}]}) as ImportJob;expect(result.status).toBe('succeeded');expect(h.commits()).toBe(1);});
  it('rechecks a revoked position before viewing or committing a preview',async()=>{const h=harness(),job=await h.start();h.setActor({id:'member-1',role:'member',job_title:'Engineer',is_active:true});await expect(h.execute({action:'get',job_id:job.id})).rejects.toThrow('import_forbidden');await expect(h.execute({action:'commit',job_id:job.id,version:job.version,mappings:[]})).rejects.toThrow('import_forbidden');expect(h.commits()).toBe(0);});
  it('super admin does not bypass the PM source or destination',async()=>{const h=harness();h.setActor({id:'s',role:'super_admin',job_title:'Executive',is_active:true});h.setPolicy(defaultImportPolicy());await expect(h.start()).rejects.toThrow('import_forbidden');});
  it('requires renewed preview when capability policy changes',async()=>{const h=harness(),job=await h.start();h.setPolicy({...defaultImportPolicy(),version:2,subjects:rule});await expect(h.execute({action:'commit',job_id:job.id,version:job.version,mappings:[]})).rejects.toThrow('preview_changed');});
  it('expires private previews and blocks unrelated job owners',async()=>{const h=harness(),job=await h.start();h.setActor({id:'other',role:'member',job_title:'PM',is_active:true});await expect(h.execute({action:'get',job_id:job.id})).rejects.toThrow('import_forbidden');h.setActor({id:'member-1',role:'member',job_title:'PM',is_active:true});h.expire();await expect(h.execute({action:'get',job_id:job.id})).rejects.toThrow('preview_expired');});
  it('does not allow import permission to grant custom page ACL management',async()=>{const h=harness(),job=await h.start();await expect(h.execute({action:'preview_target',job_id:job.id,destination:{...destination,policy:{mode:'custom',view:rule,edit:rule,comment:rule}}})).rejects.toThrow('import_forbidden');});
  it('requires the current destination version and preserves manual content',async()=>{const h=harness(),job=await h.start();await expect(h.execute({action:'preview_target',job_id:job.id,destination:{...destination,mode:'update',target_id:'pm-page',expected_version:3}})).rejects.toThrow('destination_changed');const preview=await h.execute({action:'preview_target',job_id:job.id,destination:{...destination,mode:'update',target_id:'pm-page',expected_version:4}}) as {current:{body:string};preserve_manual_body:boolean};expect(preview.current.body).toBe('<p>Human edits</p>');expect(preview.preserve_manual_body).toBe(true);});
  it('cannot import through arbitrary URLs or off-host Notion attachment redirects',()=>{expect(notionPageId('https://www.notion.so/Page-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe('a'.repeat(32));expect(()=>notionPageId('https://127.0.0.1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toThrow();expect(allowedNotionAsset('https://prod-files-secure.s3.us-west-2.amazonaws.com/file')).toBe(true);for(const url of ['http://169.254.169.254/latest','https://file.notion.so.evil.test/file','https://file.notion.so@127.0.0.1/file','https://file.notion.so:8443/file'])expect(allowedNotionAsset(url)).toBe(false);});
  it('cancel immediately removes uncommitted originals, assets and staged writes after the version fence',async()=>{
    const h=harness(),job=await h.start(),prefix=`member-1/${job.id}/`;
    job.items[0].assets=[{key:prefix+'asset',name:'asset.png',type:'image/png',size:1}];job.staged_keys=[prefix+'abandoned'];
    h.files.set(prefix+'asset',new Uint8Array(1));h.files.set(prefix+'abandoned',new Uint8Array(1));h.jobs.set(job.id,job);
    const remove=h.repo.deleteFile;h.repo.deleteFile=async key=>{expect(h.jobs.get(job.id)?.status).toBe('cancelled');await remove(key);};
    const result=await h.execute({action:'cancel',job_id:job.id}) as ImportJob;
    expect(result.status).toBe('cancelled');expect(h.files.size).toBe(0);
    await expect(h.execute({action:'commit',job_id:job.id,version:result.version,mappings:[]})).rejects.toThrow('job_not_ready');
  });
  it('cancel preserves committed source files and keeps failed deletes discoverable for scheduled retry',async()=>{
    const h=harness(),job=await h.start();
    await h.execute({action:'commit',job_id:job.id,version:job.version,mappings:[{item_id:job.items[0].id,destination,reviewed:true,confirm_audience:true}]});
    // Adapters consult durable sources, not the potentially stale job status.
    h.repo.deleteFile=async key=>{const referenced=(await h.repo.sources((await h.repo.getJob(job.id))!.items[0].page_id!)).some(source=>source.original.key===key);if(!referenced)h.files.delete(key);};
    await h.execute({action:'cancel',job_id:job.id});expect(h.files.has(job.items[0].original.key)).toBe(true);expect(h.commits()).toBe(1);
    const failed=harness(),pending=await failed.start();failed.repo.deleteFile=async()=>{throw new Error('storage unavailable');};
    const cancelled=await failed.execute({action:'cancel',job_id:pending.id}) as ImportJob;
    expect(cancelled.status).toBe('cancelled');expect(failed.files.size).toBe(1);expect(failed.jobs.has(pending.id)).toBe(true);
  });
});
