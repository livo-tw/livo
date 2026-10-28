import type { SprintCommandResult } from '@/lib/sprintLifecycle';
import { SprintCommandError } from '@/lib/sprintCommands';

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function outcome(db: Store, task: Row) {
  const status = (db.statuses ?? []).find(row => row.id === task.status_id);
  return status?.is_cancelled ? 'cancelled' : status?.is_done ? 'completed' : 'pending';
}
function snapshot(db: Store, task: Row, sprintId: string, kind: string, source: string) {
  const status = (db.statuses ?? []).find(row => row.id === task.status_id);
  const record = { id: `${sprintId}:${task.id}`, sprint_id: sprintId, task_id: task.id, task_key: task.task_key ?? '',
    title: task.title ?? '', project_id: task.project_id, status_id: task.status_id, status_name: status?.name ?? '',
    assignee_id: task.assignee_id ?? null, parent_task_id: task.parent_task_id ?? null,
    outcome: kind, source, recorded_at: new Date().toISOString() };
  const rows = db.sprint_task_history ??= [];
  const index = rows.findIndex(row => row.id === record.id);
  if (index < 0) rows.push(record); else rows[index] = record;
}
export function sprintMockTaskChange(db: Store, before: Row | null, after: Row) {
  if (before?.sprint_id && before.sprint_id !== after.sprint_id && db.sprints?.some(row => row.id === before.sprint_id && row.is_active)) {
    snapshot(db, before, String(before.sprint_id), 'removed', 'observed');
  }
  if (after.sprint_id && before?.sprint_id !== after.sprint_id && db.sprints?.some(row => row.id === after.sprint_id && row.is_active)) {
    snapshot(db, after, String(after.sprint_id), 'pending', 'observed');
  }
}

/** Isolated demo semantics only. Real backends implement their own atomic transaction. */
export function sprintMockCommand(store: Store, authId: string | undefined, value: unknown): SprintCommandResult {
  const actor = store.members?.find(row => row.auth_id === authId && row.is_active === true);
  if (!actor) throw new SprintCommandError('sprint_unauthorized');
  if (!value || typeof value !== 'object') throw new SprintCommandError('sprint_invalid_input');
  const c = value as Row;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (typeof c.commandId !== 'string' || typeof c.sprintId !== 'string' || !c.sprintId || !uuid.test(c.commandId) || !['start', 'complete'].includes(String(c.operation)) || c.operation === 'start' && !uuid.test(c.sprintId)) throw new SprintCommandError('sprint_invalid_input');
  const db = copy(store);
  const key = JSON.stringify(Object.keys(c).sort().map(name => [name, c[name]]));
  const receipt = db.sprint_commands?.find(row => row.id === c.commandId);
  if (receipt) {
    if (receipt.actor !== actor.id || receipt.payload !== key) throw new SprintCommandError('sprint_command_reused');
    return { ...(copy(receipt.result) as SprintCommandResult), replayed: true };
  }
  const now = new Date().toISOString();
  let result: SprintCommandResult;
  if (c.operation === 'start') {
    if (typeof c.name !== 'string' || !c.name.trim() || c.name.trim().length > 120 || typeof c.includeBacklog !== 'boolean' || !Array.isArray(c.taskIds) || c.taskIds.length > 2000 || c.taskIds.some(id => typeof id !== 'string')) throw new SprintCommandError('sprint_invalid_input');
    if (db.sprints?.some(row => row.is_active || row.id === c.sprintId || row.name === c.name)) throw new SprintCommandError('sprint_conflict');
    const tasks = db.tasks ?? [];
    const eligible = (task: Row) => !task.sprint_id && outcome(db, task) === 'pending' && !db.projects?.some(project => project.id === task.project_id && project.is_archived);
    const explicit = new Set(c.taskIds as string[]);
    if ([...explicit].some(id => !tasks.some(task => task.id === id && eligible(task)))) throw new SprintCommandError('sprint_invalid_input');
    const ids = tasks.filter(task => explicit.has(String(task.id)) || c.includeBacklog && eligible(task) && !db.projects?.some(project => project.id === task.project_id && project.is_archived)).map(task => String(task.id));
    (db.sprints ??= []).push({ id: c.sprintId, name: c.name.trim(), is_active: true, started_at: now, completed_at: null, completed_count: 0, cancelled_count: 0, pending_count: ids.length, version: 1, history_captured_at: null });
    for (const task of tasks) if (ids.includes(String(task.id))) { const before = copy(task); task.sprint_id = c.sprintId; sprintMockTaskChange(db, before, task); }
    result = { sprintId: c.sprintId, version: 1, completedCount: 0, cancelledCount: 0, pendingCount: ids.length, pendingIds: ids, carryIds: ids, taskIds: ids, replayed: false };
  } else {
    const sprint = db.sprints?.find(row => row.id === c.sprintId);
    if (!sprint) throw new SprintCommandError('sprint_not_found');
    if (!Number.isSafeInteger(c.expectedVersion) || !sprint.is_active || (sprint.version ?? 0) !== c.expectedVersion) throw new SprintCommandError('sprint_conflict');
    const tasks = (db.tasks ?? []).filter(task => task.sprint_id === c.sprintId);
    let completedCount = 0, cancelledCount = 0;
    const pendingIds: string[] = [];
    for (const task of tasks) {
      const kind = outcome(db, task);
      if (kind === 'completed') completedCount++; else if (kind === 'cancelled') cancelledCount++; else pendingIds.push(String(task.id));
      snapshot(db, task, String(c.sprintId), kind, 'snapshot');
    }
    Object.assign(sprint, { is_active: false, completed_at: now, completed_count: completedCount, cancelled_count: cancelledCount, pending_count: pendingIds.length, version: Number(sprint.version ?? 0) + 1, history_captured_at: now });
    for (const task of tasks) if (pendingIds.includes(String(task.id))) task.sprint_id = null;
    const carryIds = tasks.filter(task => pendingIds.includes(String(task.id)) && !db.projects?.some(project => project.id === task.project_id && project.is_archived)).map(task => String(task.id));
    result = { sprintId: String(c.sprintId), version: Number(sprint.version), completedCount, cancelledCount, pendingCount: pendingIds.length, pendingIds, carryIds, taskIds: tasks.map(task => String(task.id)), replayed: false };
  }
  (db.sprint_commands ??= []).push({ id: c.commandId, actor: actor.id, payload: key, result: copy(result) });
  for (const name of Object.keys(db)) store[name] = db[name];
  return result;
}
