import {beforeEach,describe,expect,it,vi} from 'vitest';
import {knowledgeWorkflowRequest} from './knowledgeWorkflowClient';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('@/integrations/supabase/client',()=>({USING_MOCK_BACKEND:false,supabase:{functions:{invoke}}}));
beforeEach(()=>invoke.mockReset());
describe('knowledge workflow retry outcomes',()=>{
 it('treats an unknown transport outcome as retryable, preserving frozen create forms',async()=>{
  invoke.mockResolvedValue({data:null,error:new Error('Network response lost')});
  await expect(knowledgeWorkflowRequest({action:'create_task'})).rejects.toMatchObject({status:503,code:'kb_workflow_unavailable'});
 });
 it('preserves HTTP validation and conflict statuses from the backend',async()=>{
  for(const [status,code] of [[409,'kb_workflow_conflict'],[403,'kb_workflow_forbidden'],[400,'kb_workflow_invalid']] as const){
   invoke.mockResolvedValueOnce({data:null,error:{context:new Response(JSON.stringify({error:{code}}),{status})}});
   await expect(knowledgeWorkflowRequest({action:'create_task'})).rejects.toMatchObject({status,code});
  }
 });
 it('returns the committed target for a successful receipt replay',async()=>{
  invoke.mockResolvedValue({data:{id:'link',targetId:'task'},error:null});
  await expect(knowledgeWorkflowRequest({action:'create_task',commandId:'stable-command'})).resolves.toEqual({id:'link',targetId:'task'});
 });
});
