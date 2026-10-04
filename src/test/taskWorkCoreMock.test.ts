import {describe,it,expect} from 'vitest';
import {parseTaskWorkCommand,canonicalTaskWorkPayload,taskWorkError,workCalendarDate} from '../lib/taskWork/core';
import {taskWorkMockCommand,workMockMoveSubtasks,workMockPatch} from '../integrations/supabase/taskWorkMock';
import {DEFAULT_REQUIRED_FIELDS} from '../context/UIContext';
type Row=Record<string,any>;
const command={commandId:'command-example',taskId:'t1',operation:'acknowledge',role:'assignee',expectedRevision:0};
const fixture=():Record<string,Row[]>=>({members:[{id:'m1',auth_id:'auth1',is_active:true},{id:'m2',auth_id:'auth2',is_active:true}],
  projects:[{id:'p1',key:'EXAMPLE',is_archived:false},{id:'p2',key:'OTHER',is_archived:false}],statuses:[{id:'s1'}],
  tasks:[{id:'t1',task_key:'EXAMPLE-4',project_id:'p1',title:'Parent',status_id:'s1',priority:'medium',sprint_id:'sprint1',assignee_id:'m1',reviewer_id:'m1'},
    {id:'t2',task_key:'OTHER-1',project_id:'p2',title:'Other',status_id:'s1'}]});
describe('TaskWork input and Mock transaction contract',()=>{
  it.each(['actorId','workspaceId','p_slack_identity','assignee_revision'])('rejects caller authority %s',key=>{
    expect(()=>parseTaskWorkCommand({...command,[key]:'forged'})).toThrow('work_invalid_input');
  });
  it.each(['0000-01-01','2027-02-29','2026-13-01','2026-10-10T00:00:00Z'])('rejects invalid calendar date %s',date=>expect(()=>workCalendarDate(date)).toThrow());
  it('canonicalizes normalized defaults and hides unrecognized errors',()=>{
    const first=parseTaskWorkCommand({commandId:'command-example',taskId:'t1',operation:'add_item',list:'checks',text:'  Work  '});
    expect(canonicalTaskWorkPayload(first)).toBe(canonicalTaskWorkPayload(parseTaskWorkCommand({...first,isDone:false})));
    expect(taskWorkError(new Error('internal database detail')).message).toBe('work_unavailable');
    expect(()=>parseTaskWorkCommand({...command,expectedRevision:-1})).toThrow('work_invalid_input');
    expect(()=>parseTaskWorkCommand({commandId:'command-example',taskId:'t1',operation:'update_item',list:'checks',itemId:'i1',expectedVersion:0})).toThrow();
  });
  it('acknowledges only current assignment, clears it on A to B to A, and replays latest task state',()=>{
    const db=fixture(),result=taskWorkMockCommand(db,'auth1',command);
    expect(result.task.assignee_acknowledged_at).toBeTruthy();expect(result.task.status_id).toBe('s1');
    db.tasks[0]=workMockPatch(db,'tasks',db.tasks[0],{assignee_id:'m2'});
    db.tasks[0]=workMockPatch(db,'tasks',db.tasks[0],{assignee_id:'m1'});
    const replay=taskWorkMockCommand(db,'auth1',command);
    expect(replay).toMatchObject({replayed:true,eventId:result.eventId,task:{assignee_revision:2,assignee_acknowledged_at:null}});
    expect(()=>taskWorkMockCommand(db,'auth1',{...command,commandId:'command-again'})).toThrow('work_conflict');
    expect(()=>taskWorkMockCommand(db,'auth2',{...command,commandId:'command-other',expectedRevision:2})).toThrow('work_forbidden');
    expect(db.task_work_events).toHaveLength(1);
  });
  it('does not replay cached data after deactivation or project archive',()=>{
    const db=fixture();taskWorkMockCommand(db,'auth1',command);db.members[0].is_active=false;
    expect(()=>taskWorkMockCommand(db,'auth1',command)).toThrow('work_forbidden');
    db.members[0].is_active=true;db.projects[0].is_archived=true;
    expect(()=>taskWorkMockCommand(db,'auth1',command)).toThrow('work_unavailable');
  });
  it('creates once with server key and inherited sprint, refusing required custom fields atomically',()=>{
    const db=fixture(),child={commandId:'child-command',taskId:'t1',operation:'create_subtask',title:'Child',statusId:'s1',priority:'high',dueDate:'2028-02-29'};
    const first=taskWorkMockCommand(db,'auth1',child);taskWorkMockCommand(db,'auth1',child);
    expect(first.task.id).toBe('t1');expect(first.record).toMatchObject({task_key:'EXAMPLE-5',sprint_id:'sprint1',due_date_kind:null,parent_task_id:'t1'});
    expect(db.tasks).toHaveLength(3);expect(db.task_specs).toHaveLength(1);expect(db.status_logs).toHaveLength(1);
    expect(()=>taskWorkMockCommand(db,'auth1',{...child,title:'Changed'})).toThrow('work_command_reused');
    db.custom_fields=[{project_id:'p1',is_required:true}];const before=JSON.stringify(db);
    expect(()=>taskWorkMockCommand(db,'auth1',{...child,commandId:'new-child-command'})).toThrow('work_required_fields');expect(JSON.stringify(db)).toBe(before);
  });
  it('applies the shipped required_fields default like the database: title and project are always supplied',()=>{
    const db=fixture(),child:Row={taskId:'t1',operation:'create_subtask',title:'Child',statusId:'s1',priority:'medium',assigneeId:null,reviewerId:null};
    const setRequired=(value:Row)=>{db.system_settings=[{key:'required_fields',value}];};
    setRequired({...DEFAULT_REQUIRED_FIELDS});
    expect(()=>taskWorkMockCommand(db,'auth1',{...child,commandId:'undated-child',dueDate:null})).toThrow('work_required_fields');
    expect(taskWorkMockCommand(db,'auth1',{...child,commandId:'dated-child',dueDate:'2027-02-01'}).record).toMatchObject({parent_task_id:'t1',due_date:'2027-02-01'});
    setRequired({title:true,project:true,status:true,priority:true});
    expect(taskWorkMockCommand(db,'auth1',{...child,commandId:'plain-child',dueDate:null}).record).toMatchObject({parent_task_id:'t1',due_date:null});
    setRequired({assignee:true});
    expect(()=>taskWorkMockCommand(db,'auth1',{...child,commandId:'unassigned-child',dueDate:null})).toThrow('work_required_fields');
    setRequired({title:true,background:true});const before=JSON.stringify(db);
    expect(()=>taskWorkMockCommand(db,'auth1',{...child,commandId:'background-child',dueDate:'2027-02-01'})).toThrow('work_required_fields');
    expect(JSON.stringify(db)).toBe(before);
  });
  it('moves subtasks together with their parent and refuses moving a subtask alone',()=>{
    const db=fixture();db.tasks.push({id:'c1',task_key:'EXAMPLE-5',project_id:'p1',title:'Child',status_id:'s1',parent_task_id:'t1'});
    expect(()=>workMockPatch(db,'tasks',db.tasks[2],{project_id:'p2'})).toThrow('work_invalid_parent');
    const before=db.tasks[0];db.tasks[0]=workMockPatch(db,'tasks',before,{project_id:'p2'});
    workMockMoveSubtasks(db,before,db.tasks[0]);
    expect(db.tasks.find(t=>t.id==='c1')).toMatchObject({project_id:'p2',parent_task_id:'t1'});
  });
  it('protects checklist edits from generic writes and stale form versions',()=>{
    const db=fixture(),first=taskWorkMockCommand(db,'auth1',{commandId:'item-command',taskId:'t1',operation:'add_item',list:'checks',text:'Evidence'});
    const item=first.record!;db.task_checks[0]=workMockPatch(db,'task_checks',db.task_checks[0],{text:'New evidence'});
    expect(db.task_checks[0].version).toBe(1);
    expect(()=>taskWorkMockCommand(db,'auth1',{commandId:'edit-command',taskId:'t1',operation:'delete_item',list:'checks',itemId:item.id,expectedVersion:0})).toThrow('work_conflict');
    expect(()=>workMockPatch(db,'task_checks',db.task_checks[0],{version:0})).toThrow('work_forbidden');
    expect(()=>workMockPatch(db,'tasks',db.tasks[0],{assignee_acknowledged_at:'forged'})).toThrow('work_forbidden');
  });
  it('supports authorized cross-project dependencies but rejects reverse cycles without partial audit rows',()=>{
    const db=fixture();taskWorkMockCommand(db,'auth1',{commandId:'dependency-one',taskId:'t1',operation:'add_dependency',dependsOnTaskId:'t2'});
    const before=JSON.stringify(db);
    expect(()=>taskWorkMockCommand(db,'auth1',{commandId:'dependency-two',taskId:'t2',operation:'add_dependency',dependsOnTaskId:'t1'})).toThrow('work_cycle');
    expect(JSON.stringify(db)).toBe(before);expect(db.activity_logs).toHaveLength(1);
  });
});
