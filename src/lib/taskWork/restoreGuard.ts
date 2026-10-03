const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object') : [];
export function containsTaskWorkRestoreData(backup: Record<string, unknown>): boolean {
  const hasProtectedRows = ['task_work_events', 'task_work_receipts', 'release_batches', 'release_commands', 'release_events', 'release_batch_projects', 'release_batch_tasks', 'release_outbox', 'release_slack_links', 'release_publications'].some(table => {
    const value = backup[table];
    return Array.isArray(value) ? value.length > 0 : value != null;
  });
  return hasProtectedRows || rows(backup.tasks).some(row =>
    Number(row.assignee_revision ?? 0) !== 0 || Number(row.reviewer_revision ?? 0) !== 0 || !!row.assignee_acknowledged_at || !!row.reviewer_acknowledged_at) ||
    [...rows(backup.task_checks), ...rows(backup.task_todos)].some(row => Number(row.version ?? 0) !== 0);
}
