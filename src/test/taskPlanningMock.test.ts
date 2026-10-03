import { describe,it,expect } from 'vitest';
import { planningMockRpc,planningMockSuppressed,planningMockUpdate } from '@/integrations/supabase/taskPlanningMock';
const setup=()=>({members:[{id:'m1',auth_id:'a1',is_active:true},{id:'m2',auth_id:'a2',is_active:true}],projects:[{id:'p1',is_archived:false}],tasks:[{id:'t1',project_id:'p1',due_date:'2026-10-10',due_date_kind:'committed',due_date_version:0,started_at:'2026-10-01T03:00:00Z'}],task_deadline_history:[] as Record<string,unknown>[],task_reminder_preferences:[] as Record<string,unknown>[]});
describe('Mock planning parity',()=>{
 it('atomically changes Gantt dates and audits the known actor',()=>{
   const db=setup(),args={p_task_id:'t1',p_expected_version:0,p_due_date:'2026-10-11',p_kind:'committed',p_reason:'blocked',p_change_start:true,p_expected_started_at:'2026-10-01T03:00:00Z',p_started_at:'2026-10-02'};
   expect(planningMockRpc(db,'a1','livo_set_task_deadline',args)).toMatchObject({due_date_version:1,started_at:'2026-10-02'});
   expect(db.task_deadline_history).toHaveLength(1);expect(db.task_deadline_history[0]).toMatchObject({actor_id:'m1',reason:'blocked'});
   expect(()=>planningMockRpc(db,'a1','livo_set_task_deadline',args)).toThrow('planning_conflict');expect(db.task_deadline_history).toHaveLength(1);
 });
 it('rolls back failed combined changes and does not bypass commitment by downgrading kind',()=>{
   const db=setup();expect(()=>planningMockRpc(db,'a1','livo_set_task_deadline',{p_task_id:'t1',p_expected_version:0,p_due_date:null,p_kind:null,p_change_start:true,p_expected_started_at:db.tasks[0].started_at,p_started_at:'2026-10-02'})).toThrow('planning_reason_required');
   expect(db.tasks[0].started_at).toBe('2026-10-01T03:00:00Z');expect(db.task_deadline_history).toHaveLength(0);
   expect(()=>planningMockUpdate(db.tasks[0],{due_date:'2026-10-12',due_date_kind:'estimated'},'m1')).toThrow('planning_reason_required');
 });
 it('allows ordinary old-card changes and leaves missing reasons unknown',()=>{
   const change=planningMockUpdate({...setup().tasks[0],due_date_kind:null},{due_date:'2026-10-20'},'m1');
   expect(change.history?.reason).toBeNull();expect(change.row.due_date_version).toBe(1);
 });
 it('pauses only the caller due reminders, not responsibility or other members',()=>{
   const db=setup(),until=new Date(Date.now()+86400000).toISOString();
   const result=planningMockRpc(db,'a1','livo_set_task_reminder',{p_task_id:'t1',p_expected_version:0,p_until:until,member_id:'m2'});
   expect(result).toMatchObject({member_id:'m1',version:1});
   expect(planningMockSuppressed(db,{type:'due_soon',task_id:'t1',recipient_id:'m1'})).toBe(true);
   expect(planningMockSuppressed(db,{type:'assign',task_id:'t1',recipient_id:'m1'})).toBe(false);
   expect(planningMockSuppressed(db,{type:'due_soon',task_id:'t1',recipient_id:'m2'})).toBe(false);
   planningMockRpc(db,'a1','livo_set_task_reminder',{p_task_id:'t1',p_expected_version:1,p_until:null});
   expect(planningMockSuppressed(db,{type:'due_soon',task_id:'t1',recipient_id:'m1'})).toBe(false);
 });
});
