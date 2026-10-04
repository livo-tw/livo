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
 it('an owner deletes an own draft after knowledge work; its receipt, event and links go with it',async()=>{
  const saved=await save();const id=saved.page.pageId;
  const result=await client.from('kb_pages').delete().eq('id',id).select('*').single();
  expect(result.error).toBeNull();expect(result.data.id).toBe(id);
  const drafts=(await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'drafts',cursor:0}}})).data;
  expect(drafts.items).toEqual([]);
  expect((await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'command_result',commandId:'mock-private-command'}}})).data).toEqual({found:false});
 });
 it('deleting a linked source page removes the link from another draft and keeps that draft',async()=>{
  const found=(await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'search',query:'decision',types:['knowledge'],projectIds:[],effectiveOnly:false,cursor:0}}})).data;
  const sourceRefs=found.items.filter(item=>item.id==='kb-demo-howto').map(({kind,id,version})=>({kind,id,version}));
  expect(sourceRefs).toHaveLength(1);
  const preview=(await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'prepare_draft',input:{...input,sourceRefs}}}})).data;
  expect(preview.error).toBeUndefined();
  const saved=(await client.functions.invoke('knowledge-work',{body:{type:'command',command:{commandId:'mock-linked-command',operation:'save_draft',preview,title:input.title,text:input.notes,confirmed:true}}})).data;
  expect(saved.page.links).toHaveLength(1);
  expect((await client.from('kb_pages').delete().eq('id','kb-demo-howto').select('*').single()).error).toBeNull();
  const detail=(await client.functions.invoke('knowledge-work',{body:{type:'query',query:{operation:'detail',pageId:saved.page.pageId}}})).data;
  expect(detail.privateDraftOwnerId).toBe('m-001');expect(detail.links).toEqual([]);
  // A dangling link would make the draft impossible to share.
  const shared=(await client.functions.invoke('knowledge-work',{body:{type:'command',command:{commandId:'mock-share-after-delete',operation:'share_draft',pageId:saved.page.pageId,expectedVersion:detail.pageVersion,projectId:null,parentId:null,confirmed:true}}})).data;
  expect(shared.error).toBeUndefined();expect(shared.page.privateDraftOwnerId).toBeNull();
 });
 it('a shared page cannot be moved under a private draft',async()=>{
  const saved=await save();
  const moved=await client.from('kb_pages').update({parent_id:saved.page.pageId}).eq('id','kb-demo-howto').select('*').single();
  expect(moved.error.message).toBe('kb_private_draft_parent');
  expect((await client.from('kb_pages').select('parent_id').eq('id','kb-demo-howto').single()).data.parent_id).toBe('kb-demo-guide');
 });
 it('ordinary members cannot invoke the raw existence probe',async()=>{await client.auth.signInWithPassword({email:'jingru@livo.test',password:'test1234'});expect((await client.functions.invoke('knowledge-restore-check',{body:{}})).error.message).toBe('knowledge_forbidden');});
});
