// @vitest-environment node
import {test} from 'vitest';
import assert from 'node:assert/strict';
import {assertPlanningImportSafe} from '../../worker/migrate/task-planning-import-guard.mjs';
test('legacy records and explicit initial kinds do not fabricate history',()=>{
  assert.doesNotThrow(()=>assertPlanningImportSafe(name=>name==='tasks'?[{due_date:'2026-10-10',due_date_version:0,due_date_kind:'estimated'}]:[]));
});
for(const [name,row] of [['task_deadline_history',{version:1}],['task_reminder_preferences',{snoozed_until:null}],['tasks',{due_date_version:1}]])
  test(`refuses ${name} before any SQL is generated or executed`,()=>{
    assert.throws(()=>assertPlanningImportSafe(table=>table===name?[row]:[]),/planning_history_requires_restore/);
  });
test('malformed input fails closed',()=>assert.throws(()=>assertPlanningImportSafe(()=>({})),/Invalid planning/));
