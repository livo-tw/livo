/** Cross-database restore needs a dedicated audit-preserving migration, not
 * INSERT OR REPLACE. Call before transformation AND before import execution. */
export function assertPlanningImportSafe(readRows) {
  const history=readRows('task_deadline_history'),preferences=readRows('task_reminder_preferences'),tasks=readRows('tasks');
  if(![history,preferences,tasks].every(Array.isArray))throw new Error('Invalid planning import data');
  if(history.length || preferences.length || tasks.some(task=>Number(task.due_date_version||0)>0)) {
    throw new Error('planning_history_requires_restore: Use a verified full server restore or dedicated cross-database migration; deadline history and reminder preferences cannot be discarded.');
  }
}
