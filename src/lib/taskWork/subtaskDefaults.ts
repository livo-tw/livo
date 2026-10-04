import type { Task } from '@/types';
import { workCalendarDate } from './core';

export type SubtaskRequiredFields = Partial<Record<'dueDate' | 'assignee' | 'reviewer', boolean>>;

const calendarDateOrNull = (value: string | undefined): string | null => {
  try { return workCalendarDate(value ?? null); } catch { return null; }
};

/**
 * The subtask quick create only asks for a title; the command always supplies the
 * title, the parent's project, a status and a priority. When the team requires a
 * due date, assignee or reviewer, the parent's value is used (the same values the
 * main create form just validated for the parent), so the card is created complete.
 * Fields the team does not require stay empty, as before. If the parent has no
 * usable value the server refuses with `work_required_fields` instead of creating
 * an incomplete card.
 */
export function subtaskQuickCreateFields(
  parent: Pick<Task, 'dueDate' | 'assigneeId' | 'reviewerId'>,
  required: SubtaskRequiredFields | undefined,
): { dueDate: string | null; assigneeId: string | null; reviewerId: string | null } {
  return {
    dueDate: required?.dueDate ? calendarDateOrNull(parent.dueDate) : null,
    assigneeId: required?.assignee ? parent.assigneeId || null : null,
    reviewerId: required?.reviewer ? parent.reviewerId || null : null,
  };
}
