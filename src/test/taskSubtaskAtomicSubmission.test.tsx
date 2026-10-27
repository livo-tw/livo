import {act,cleanup,renderHook} from '@testing-library/react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type {Project,Task} from '@/types';
import type {TaskResponsibility} from '@/lib/taskWork/client';
import type {TaskWorkCommand} from '@/lib/taskWork/core';

const transport=vi.hoisted(()=>({invoke:vi.fn(),from:vi.fn()}));
vi.mock('@/integrations/supabase/client',()=>({supabase:{functions:{invoke:transport.invoke},from:transport.from}}));
vi.mock('@/i18n',()=>({default:{t:(key:string)=>key}}));
vi.mock('sonner',()=>({toast:{error:vi.fn()}}));
import {useTaskCRUD} from '@/context/hooks/useTaskCRUD';
const parent:Task={id:'parent-example',taskKey:'EX-1',projectId:'project-example',title:'Parent',statusId:'open',priority:'medium',creatorId:'member-example',sortOrder:0,createdAt:'',commentCount:0,attachmentCount:0,deployments:[]};
const project:Project={id:parent.projectId,lineId:'line-example',name:'Example Project',key:'EX',color:'#123456',isArchived:false};
const details={requirement:'<p>Child own details</p>',customFields:[{fieldId:'field-example',valueNumber:0}]};
const response=(commandId:string):{commandId:string;replayed:boolean;eventId:string;task:TaskResponsibility;record:Record<string,unknown>}=>({commandId,replayed:true,eventId:'event-example',task:{id:parent.id,assignee_id:null,reviewer_id:null,assignee_revision:0,reviewer_revision:0,assignee_acknowledged_at:null,reviewer_acknowledged_at:null},record:{id:'child-example',parent_task_id:parent.id,project_id:parent.projectId,task_key:'EX-2',title:'Child',status_id:'open',priority:'medium',creator_id:'member-example',sort_order:0,created_at:'',comment_count:0}});
beforeEach(()=>{transport.invoke.mockReset();transport.from.mockReset();});
afterEach(cleanup);
it('keeps the same atomic command across a real hook rerender and uncertain transport retry',async()=>{
  transport.invoke.mockRejectedValueOnce(new Error('Lost response')).mockRejectedValueOnce(new Error('Lost response'))
    .mockImplementation(async(_name:string,options:{body:TaskWorkCommand})=>({data:response(options.body.commandId),error:null}));
  const setTasks=vi.fn();
  const {result,rerender}=renderHook(()=>useTaskCRUD({allTasks:[parent],statuses:[],setAllTasks:setTasks,refreshTasks:vi.fn(),appendStatusLog:vi.fn()}));
  let firstError:unknown;
  await act(async()=>{try{await result.current.createCreateSubtask([project],'member-example')(parent.id,'Child',parent.projectId,'open',undefined,{details});}catch(error){firstError=error;}});
  expect(firstError).toMatchObject({code:'work_transport_error'});expect(setTasks).not.toHaveBeenCalled();
  rerender();
  let stored:Task|null=null;
  await act(async()=>{stored=await result.current.createCreateSubtask([project],'member-example')(parent.id,'Child',parent.projectId,'open',undefined,{details});});
  expect(stored).toMatchObject({id:'child-example',parentTaskId:parent.id});expect(setTasks).toHaveBeenCalledOnce();
  expect(new Set(transport.invoke.mock.calls.map(call=>call[1].body.commandId)).size).toBe(1);
  expect(transport.invoke.mock.calls).toHaveLength(3);
  expect(transport.invoke.mock.calls[2][1].body.details).toEqual(details);
  expect(transport.from).not.toHaveBeenCalled();
});
it('keeps legacy quick-create rejection feedback compatible and propagates complete-form failures',async()=>{
  transport.invoke.mockResolvedValue({data:{error:'work_required_fields'},error:null});
  const {result}=renderHook(()=>useTaskCRUD({allTasks:[parent],statuses:[],setAllTasks:vi.fn(),refreshTasks:vi.fn(),appendStatusLog:vi.fn()}));
  const create=result.current.createCreateSubtask([project],'member-example');
  await expect(create(parent.id,'Child',parent.projectId,'open')).resolves.toBeNull();
  await expect(create(parent.id,'Child',parent.projectId,'open',undefined,{details})).rejects.toMatchObject({code:'work_required_fields'});
  expect(transport.from).not.toHaveBeenCalled();
});
