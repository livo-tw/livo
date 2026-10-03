import {describe,it,expect} from 'vitest';
import {assertTaskWorkImportSafe} from '../../worker/migrate/task-work-import-guard.mjs';
describe('TaskWork import loss prevention',()=>{
  it('permits legacy rows with no work history',()=>expect(()=>assertTaskWorkImportSafe(name=>name==='tasks'?[{id:'example',assignee_revision:0}]:[])).not.toThrow());
  it.each(['task_work_events','task_work_receipts'])('refuses %s before writing',table=>expect(()=>assertTaskWorkImportSafe(name=>name===table?[{id:'example'}]:[])).toThrow('work_history_requires_restore'));
  it.each([{assignee_revision:1},{reviewer_revision:1},{assignee_acknowledged_at:'example'},{reviewer_acknowledged_at:'example'}])('preserves assignment history %j',row=>expect(()=>assertTaskWorkImportSafe(name=>name==='tasks'?[row]:[])).toThrow('work_history_requires_restore'));
  it.each(['task_checks','task_todos'])('preserves %s versions',table=>expect(()=>assertTaskWorkImportSafe(name=>name===table?[{version:1}]:[])).toThrow('work_history_requires_restore'));
  it('fails closed on malformed export data',()=>expect(()=>assertTaskWorkImportSafe(()=>null)).toThrow('Invalid release import data'));
});
