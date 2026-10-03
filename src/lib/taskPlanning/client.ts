import { supabase } from '@/integrations/supabase/client';
import { calendarDate, deadlineChange, dueDateKind, reminderUntil, TaskPlanningError, type DeadlineState, type DueDateKind } from './core';
import type { Task } from '@/types';

export type TaskReminder = { id: string; task_id: string; member_id: string; snoozed_until: string | null; version: number; updated_at: string };
export type TaskDeadline = { id: string; due_date: string | null; due_date_kind: DueDateKind; due_date_version: number; started_at: string | null };
export type TaskDeadlineHistory = { id: string; task_id: string; actor_id: string | null; previous_due_date: string | null; next_due_date: string | null; previous_kind: DueDateKind; next_kind: DueDateKind; reason: string | null; version: number; changed_at: string };

const codes = new Set(['planning_forbidden', 'planning_unavailable', 'planning_conflict', 'planning_invalid_input', 'planning_invalid_date', 'planning_invalid_kind', 'planning_date_required', 'planning_invalid_reason', 'planning_reason_required', 'planning_invalid_pause', 'planning_invalid_timezone']);
export function planningErrorCode(error: unknown): string {
  if (error instanceof TaskPlanningError && codes.has(error.code)) return error.code;
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === 'string' && codes.has(value.code)) return value.code;
    if (typeof value.message === 'string' && codes.has(value.message)) return value.message;
  }
  return 'planning_unavailable';
}
function checked<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) throw new TaskPlanningError(planningErrorCode(result.error));
  if (result.data === null) throw new TaskPlanningError('planning_unavailable');
  return result.data;
}
function validVersion(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskPlanningError('planning_invalid_input');
}
function reminderRow(row: TaskReminder): TaskReminder {
  if (!row || typeof row.id !== 'string' || typeof row.task_id !== 'string' || typeof row.member_id !== 'string') throw new TaskPlanningError('planning_unavailable');
  validVersion(row.version);
  if (row.snoozed_until !== null && (typeof row.snoozed_until !== 'string' || !Number.isFinite(Date.parse(row.snoozed_until)))) throw new TaskPlanningError('planning_unavailable');
  return row;
}
export async function getTaskReminder(taskId: string, memberId: string): Promise<TaskReminder | null> {
  const rows = checked(await supabase.from('task_reminder_preferences').select('*').eq('task_id', taskId).eq('member_id', memberId).limit(1));
  return rows.length ? reminderRow(rows[0]) : null;
}
export async function listTaskReminderPreferences(memberId: string): Promise<TaskReminder[]> {
  const all: TaskReminder[] = [];
  for (let start = 0; ; start += 500) {
    const rows = checked(await supabase.from('task_reminder_preferences').select('*').eq('member_id', memberId).order('id').range(start, start + 499));
    all.push(...rows.map(reminderRow));
    if (rows.length < 500) return all;
  }
}
export async function setTaskReminder(taskId: string, expectedVersion: number, until: string | null): Promise<TaskReminder> {
  validVersion(expectedVersion);
  const row = checked(await supabase.rpc('livo_set_task_reminder', { p_task_id: taskId, p_expected_version: expectedVersion, p_until: reminderUntil(until) }));
  return reminderRow(row);
}
export async function setTaskDeadline(taskId: string, before: DeadlineState, date: string | null, kind: DueDateKind, reason: string | null, start?: { before: string | null; next: string | null }): Promise<TaskDeadline> {
  validVersion(before.version);
  const next = deadlineChange(before, date, kind, reason);
  const row = checked(await supabase.rpc('livo_set_task_deadline', {
    p_task_id: taskId, p_expected_version: before.version, p_due_date: next.dueDate, p_kind: next.kind, p_reason: next.reason,
    ...(start ? { p_change_start: true, p_expected_started_at: start.before, p_started_at: calendarDate(start.next) } : {}),
  }));
  if (!row || row.id !== taskId) throw new TaskPlanningError('planning_unavailable');
  validVersion(row.due_date_version); calendarDate(row.due_date); dueDateKind(row.due_date_kind);
  if (row.started_at !== null && typeof row.started_at !== 'string') throw new TaskPlanningError('planning_unavailable');
  return row;
}
export function deadlineTaskFields(row: TaskDeadline): Pick<Task, 'dueDate' | 'dueDateKind' | 'dueDateVersion' | 'startedAt'> {
  return { dueDate: row.due_date || undefined, dueDateKind: row.due_date_kind, dueDateVersion: row.due_date_version, startedAt: row.started_at || undefined };
}
export async function getTaskDeadlineHistory(taskId: string): Promise<TaskDeadlineHistory[]> {
  return checked(await supabase.from('task_deadline_history').select('*').eq('task_id', taskId).order('version', { ascending: false }).limit(20));
}
