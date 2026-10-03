/** Pure preflight: preserve source exports and refuse lossy INSERT OR REPLACE. */
export function assertTaskWorkImportSafe(readRows) {
  if (['release_batches','release_commands','release_events','release_batch_projects','release_batch_tasks','release_outbox','release_slack_links', 'release_publications'].some(table => {
    const rows = readRows(table); if (!Array.isArray(rows)) throw new Error('Invalid release import data'); return rows.length > 0;
  })) throw new Error('release_history_requires_restore: Use a verified full server restore; release manifests and evidence must not be discarded.');
  const tables=['task_work_events','task_work_receipts','tasks','task_checks','task_todos'];
  const rows=Object.fromEntries(tables.map(name=>[name,readRows(name)]));
  if(Object.values(rows).some(value=>!Array.isArray(value)))throw new Error('Invalid task work import data');
  if(rows.task_work_events.length||rows.task_work_receipts.length||rows.tasks.some(t=>Number(t.assignee_revision||0)>0||Number(t.reviewer_revision||0)>0||t.assignee_acknowledged_at||t.reviewer_acknowledged_at)
    ||rows.task_checks.some(t=>Number(t.version||0)>0)||rows.task_todos.some(t=>Number(t.version||0)>0))
    throw new Error('work_history_requires_restore: Use a verified full server restore or dedicated cross-database migration; task work history and assignment receipts cannot be discarded.');
}
