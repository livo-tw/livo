import type { Task, Priority, CustomField } from '@/types';
import type { TaskWorkSubtaskDetails, TaskWorkCustomValue } from './core';
import { workCalendarDate } from './core';
import type { CustomFieldDraft } from '@/lib/customFieldValues';

export type SubtaskRequiredFields = Partial<Record<'title' | 'project' | 'status' | 'priority' | 'dueDate' | 'assignee' | 'reviewer' | 'startDate' | 'tags' | 'background' | 'requirement' | 'notes' | 'checks' | 'todos' | 'gitlabUrl' | 'deployments', boolean>>;
export type SubtaskCreateValues = { priority?: Priority; dueDate?: string | null; assigneeId?: string | null; reviewerId?: string | null; details?: TaskWorkSubtaskDetails };

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

/** Title-only creation cannot collect these fields; open the shared complete form. */
export function subtaskNeedsFullForm(required: SubtaskRequiredFields | undefined, requiredCustomFields: boolean,
  parent?: Pick<Task, 'dueDate' | 'assigneeId' | 'reviewerId'>): boolean {
  if (requiredCustomFields || ['startDate','tags','background','requirement','notes','checks','todos','gitlabUrl','deployments']
    .some(key => required?.[key as keyof SubtaskRequiredFields])) return true;
  if (!parent) return false;
  const inherited = subtaskQuickCreateFields(parent, required);
  return !!(required?.dueDate && !inherited.dueDate || required?.assignee && !inherited.assigneeId || required?.reviewer && !inherited.reviewerId);
}

/** Send the visible value of the current field type; false/zero are real answers. */
export function subtaskCustomValues(fields: CustomField[], values: Record<string, CustomFieldDraft>): TaskWorkCustomValue[] {
  return fields.flatMap<TaskWorkCustomValue>(field => {
    const value = values[field.id];
    switch (field.fieldType) {
      case 'boolean': return field.isRequired || value?.valueBoolean !== undefined ? [{ fieldId:field.id,valueBoolean:value?.valueBoolean ?? false }] : [];
      case 'number': return value?.valueNumber !== undefined ? [{fieldId:field.id,valueNumber:value.valueNumber}] : [];
      case 'date': return value?.valueDate ? [{fieldId:field.id,valueDate:value.valueDate}] : [];
      case 'user': return value?.valueUserId ? [{fieldId:field.id,valueUserId:value.valueUserId}] : [];
      default: return value?.valueText?.trim() ? [{fieldId:field.id,valueText:value.valueText}] : [];
    }
  });
}
