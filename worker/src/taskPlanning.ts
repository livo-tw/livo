import type { AuthCtx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';
import { calendarDate, dueDateKind, reminderUntil, TaskPlanningError } from './taskPlanningCore';

export const PLANNING_FNS = new Set(['livo_set_task_deadline','livo_set_task_reminder']);
const has = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value,key);
export function deadlinePatch(value: Record<string, unknown>, memberId: string): Record<string, unknown> {
  if (has(value,'due_date_changed_by') || has(value,'due_date_version')) throw new TaskPlanningError('planning_invalid_input');
  const patch = { ...value };
  if (has(patch,'due_date')) patch.due_date = calendarDate(patch.due_date);
  if (has(patch,'due_date_kind')) patch.due_date_kind = dueDateKind(patch.due_date_kind);
  if (has(patch,'due_date') && patch.due_date === null) patch.due_date_kind = null;
  if (has(patch,'due_date_change_reason')) {
    if (patch.due_date_change_reason !== null && typeof patch.due_date_change_reason !== 'string') throw new TaskPlanningError('planning_invalid_reason');
    const reason = typeof patch.due_date_change_reason === 'string' ? patch.due_date_change_reason.trim() : null;
    if (reason && ([...reason].length>2000 || reason.includes('\0'))) throw new TaskPlanningError('planning_invalid_reason');
    patch.due_date_change_reason = reason || null;
  }
  if (has(patch,'due_date') || has(patch,'due_date_kind')) {
    patch.due_date_changed_by=memberId;
    patch.due_date_change_reason ??= null;
  }
  return patch;
}
/** The version expression is evaluated against the current row, in the same
 * UPDATE as its data. It also covers generic upserts, without trusting a client
 * supplied actor or version. Values are separately bound by the query engine. */
export function deadlineVersionSql(patch: Record<string, unknown>, upsert = false) {
  const terms: string[] = [], params: unknown[] = [];
  for (const key of ['due_date','due_date_kind']) if (has(patch,key)) {
    const left = key==='due_date' ? "NULLIF(tasks.due_date,'')" : 'tasks.due_date_kind';
    const right = upsert ? `excluded.${key}` : '?';
    terms.push(`${left} IS NOT ${right}`);
    if (!upsert) params.push(patch[key]);
  }
  return { sql: terms.length ? `due_date_version = tasks.due_date_version + CASE WHEN ${terms.join(' OR ')} THEN 1 ELSE 0 END` : '', params };
}
export async function livePlanningMember(env: Env, auth: AuthCtx) {
  const ws=auth.member.workspaceId || DEFAULT_WORKSPACE;
  const row=await env.DB.prepare(`SELECT m.id FROM members m JOIN auth_users u ON u.id=m.auth_id
    WHERE m.workspace_id=? AND m.id=? AND m.auth_id=? AND m.is_active=1 AND COALESCE(u.banned,0)=0
    AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1`)
    .bind(ws,auth.member.id,auth.userId).first();
  if (!row) throw new TaskPlanningError('planning_forbidden',403);
  return ws;
}
export async function taskPlanningRpc(env: Env, auth: AuthCtx, fn: string, args: Record<string, unknown>) {
  const ws=await livePlanningMember(env,auth), actor=auth.member.id;
  const task=typeof args.p_task_id==='string' ? args.p_task_id : '';
  const version=args.p_expected_version;
  if (!task || !Number.isSafeInteger(version) || Number(version)<0) throw new TaskPlanningError('planning_invalid_input');
  // Repeat live identity/task checks in the mutation: a cached/preflight member
  // must not authorize a concurrent deactivation or project archive.
  const visible=`EXISTS(SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
    JOIN members m ON m.workspace_id=t.workspace_id AND m.id=? AND m.auth_id=? AND m.is_active=1
    JOIN auth_users u ON u.id=m.auth_id AND COALESCE(u.banned,0)=0
    WHERE t.workspace_id=? AND t.id=? AND COALESCE(p.is_archived,0)=0
    AND (SELECT count(*) FROM members x WHERE x.workspace_id=m.workspace_id AND x.auth_id=m.auth_id AND x.is_active=1)=1)`;
  let row: Record<string,unknown>|null;
  if (fn==='livo_set_task_reminder') {
    const until=reminderUntil(args.p_until);
    row=await env.DB.prepare(`INSERT INTO task_reminder_preferences(workspace_id,id,task_id,member_id,snoozed_until,version,updated_at)
      SELECT ?,?,?,?,?,1,? WHERE ${visible} AND (?=0 OR EXISTS(SELECT 1 FROM task_reminder_preferences WHERE workspace_id=? AND task_id=? AND member_id=?))
      ON CONFLICT(workspace_id,task_id,member_id) DO UPDATE SET snoozed_until=excluded.snoozed_until,version=task_reminder_preferences.version+1,updated_at=excluded.updated_at
      WHERE task_reminder_preferences.version=? RETURNING *`)
      .bind(ws,crypto.randomUUID(),task,actor,until,new Date().toISOString(),actor,auth.userId,ws,task,version,ws,task,actor,version).first();
  } else {
    const date=calendarDate(args.p_due_date), kind=dueDateKind(args.p_kind);
    if (date===null && kind!==null) throw new TaskPlanningError('planning_date_required');
    const changeStart=args.p_change_start ?? false;
    if (typeof changeStart!=='boolean') throw new TaskPlanningError('planning_invalid_input');
    const start=changeStart ? calendarDate(args.p_started_at) : null;
    const expectedStart=changeStart ? args.p_expected_started_at??null : null;
    if(expectedStart!==null && typeof expectedStart!=='string') throw new TaskPlanningError('planning_invalid_input');
    const patch=deadlinePatch({due_date:date,due_date_kind:kind,due_date_change_reason:args.p_reason??null},actor);
    row=await env.DB.prepare(`UPDATE tasks SET due_date=?,due_date_kind=?,due_date_change_reason=?,due_date_changed_by=?,
      started_at=CASE WHEN ? THEN ? ELSE started_at END,
      due_date_version=due_date_version+CASE WHEN NULLIF(due_date,'') IS NOT ? OR due_date_kind IS NOT ? THEN 1 ELSE 0 END
      WHERE workspace_id=? AND id=? AND due_date_version=? AND (?=0 OR NULLIF(started_at,'') IS ?) AND ${visible}
      RETURNING id,due_date,due_date_kind,due_date_version,started_at`)
      .bind(date,kind,patch.due_date_change_reason,actor,changeStart?1:0,start,date,kind,ws,task,version,changeStart?1:0,expectedStart,actor,auth.userId,ws,task).first();
  }
  if (!row) throw new TaskPlanningError('planning_conflict',409);
  return row;
}
export function planningError(error: unknown): string {
  const message=error instanceof Error ? error.message : '';
  const match=message.match(/\bplanning_(forbidden|unavailable|conflict|invalid_input|invalid_date|invalid_kind|date_required|invalid_reason|reason_required|invalid_pause)\b/);
  return match?.[0] || 'planning_failed';
}
