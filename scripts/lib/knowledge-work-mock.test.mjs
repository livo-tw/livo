import {beforeEach,describe,it,expect} from 'vitest';
import {createMockClient} from '../../src/integrations/supabase/mockClient';
const client=createMockClient();
beforeEach(async()=>{client.constructor.resetMockData();await client.auth.signInWithPassword({email:'admin@livo.test',password:'test1234'});});
const input={kind:'meeting',title:'Private synthetic draft',notes:'Private source',sourceRefs:[]};
async function save(){const {data:preview}=await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'prepare_draft',input}}});return (await client.functions.invoke('knowledge-work',{body:{type:'command',command:{commandId:'mock-private-command',operation:'save_draft',preview,title:input.title,text:input.notes,confirmed:true}}})).data;}
describe('knowledge Mock ACL and restoration',()=>{
 it('staging-only imports block broad task deletion and the restore probe',async()=>{
  const {data:pages}=await client.from('kb_pages').select('id');await client.from('kb_pages').delete().in('id',pages.map(p=>p.id));
  expect((await client.from('kb_pages').select('id')).data).toEqual([]);
  expect((await client.functions.invoke('knowledge-restore-check',{body:{}})).data.available).toBe(true);
  await client.from('knowledge_import_jobs').insert({id:'staged-only',actor_id:'different-owner',data:{body:'PRIVATE STAGED CONTENT'}});
  expect(await client.functions.invoke('knowledge-restore-check',{body:{}})).toEqual({data:{available:false},error:null});
  const before=await client.from('tasks').select('id');
  const deletion=await client.from('tasks').delete().neq('id','___none___');
  expect(deletion.error.message).toContain('knowledge_requires_server_restore');
  expect((await client.from('tasks').select('id')).data).toEqual(before.data);
 });
 it('requires a real mock login; no anonymous owner fallback',async()=>{await client.auth.signOut();const result=await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'drafts',cursor:0}}});expect(result.data.error).toBe('knowledge_forbidden');});
 it('global restore existence sees hidden drafts and returns only a boolean',async()=>{
  const {data:pages}=await client.from('kb_pages').select('id');await client.from('kb_pages').delete().in('id',pages.map(p=>p.id));const saved=await save();expect(saved.page.privateDraftOwnerId).toBe('m-001');
  await client.auth.signInWithPassword({email:'yaqi@livo.test',password:'test1234'});const read=await client.from('kb_pages').select('*');expect(read.data).toEqual([]);
  const result=await client.functions.invoke('knowledge-restore-check',{body:{}});expect(result).toEqual({data:{available:false},error:null});expect(JSON.stringify(result)).not.toContain(input.title);
  const before=await client.from('tasks').select('id');const deletion=await client.from('tasks').delete().neq('id','___none___');expect(deletion.error.message).toContain('knowledge_requires_server_restore');expect((await client.from('tasks').select('id')).data).toHaveLength(before.data.length);
 });
 it('cannot publish another member draft or clear owner through generic writes',async()=>{const saved=await save();expect((await client.from('kb_pages').update({private_draft_owner_id:null}).eq('id',saved.page.pageId)).error.message).toBe('knowledge_forbidden');await client.auth.signInWithPassword({email:'yaqi@livo.test',password:'test1234'});const read=await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'detail',pageId:saved.page.pageId}}});expect(read.data.error).toBe('knowledge_unavailable');});
 it('ordinary members cannot invoke the raw existence probe',async()=>{await client.auth.signInWithPassword({email:'jingru@livo.test',password:'test1234'});expect((await client.functions.invoke('knowledge-restore-check',{body:{}})).error.message).toBe('knowledge_forbidden');});
});
