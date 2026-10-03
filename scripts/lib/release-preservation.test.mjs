import {describe,it,expect} from 'vitest';
import {assertTaskWorkImportSafe} from '../../worker/migrate/task-work-import-guard.mjs';
import {containsTaskWorkRestoreData} from '../../src/lib/taskWork/restoreGuard.ts';
const protectedTables=['release_batches','release_commands','release_events','release_batch_projects','release_batch_tasks','release_outbox','release_slack_links','release_publications'];
describe('release history preservation',()=>{
 it.each(protectedTables)('refuses lossy cross-database import and browser restoration of %s',table=>{
  const backup={[table]:[{id:'synthetic',batch_id:'synthetic'}]};expect(()=>assertTaskWorkImportSafe(name=>backup[name]??[])).toThrow('release_history_requires_restore');expect(containsTaskWorkRestoreData(backup)).toBe(true);
 });
 it('rejects malformed protected history rather than treating it as empty',()=>{expect(containsTaskWorkRestoreData({release_publications:{invalid:true}})).toBe(true);expect(()=>assertTaskWorkImportSafe(name=>name==='release_events'?null:[])).toThrow('Invalid release import data');});
 it('permits empty release tables without changing existing legacy import behavior',()=>{expect(()=>assertTaskWorkImportSafe(()=>[])).not.toThrow();expect(containsTaskWorkRestoreData({release_batches:[]})).toBe(false);});
});
