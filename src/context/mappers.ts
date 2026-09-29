import { Task, Project, User, Status, ProductLine, TaskSpec, TaskCheck, TaskTodo, Comment, StatusLog, Tag, CustomField, TaskCustomFieldValue, TaskTemplate, TaskDependency, TaskDeployment } from '@/types';
import type { Tables } from '@/integrations/supabase/types';

// Local type helpers for tables not yet in the generated DB schema
export type TagRow = { id: string; name: string; color: string };
export type TaskTagRow = { task_id: string; tag_id: string };
export type SprintRow = Tables<'sprints'>;
export type CustomFieldRow = { id: string; project_id: string; field_name: string; field_type: string; options?: unknown; is_required: boolean; default_value?: string | null; sort_order: number; created_at: string };
export type CustomFieldValueRow = { id: string; task_id: string; field_id: string; value_text?: string | null; value_number?: number | null; value_date?: string | null; value_boolean?: boolean | null; value_user_id?: string | null };
export type TaskTemplateRow = { id: string; project_id?: string | null; name: string; description?: string; default_priority?: string | null; default_tag_ids?: string[]; default_spec_background?: string; default_spec_requirement?: string; default_spec_notes?: string; default_check_items?: string[]; default_todo_items?: string[]; created_by: string; created_at: string; updated_at: string };
export type TaskDependencyRow = { id: string; task_id: string; depends_on_task_id: string; dependency_type?: string; created_at: string };
export type TaskRow = Tables<'tasks'> & { parent_task_id?: string | null; tag_ids?: string[]; approval_status?: string | null; current_approval_id?: string | null; requires_approval?: boolean };
export type MemberRow = Tables<'members'> & { theme?: string };

export function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    taskKey: row.task_key,
    projectId: row.project_id,
    title: row.title,
    statusId: row.status_id,
    priority: row.priority,
    creatorId: row.creator_id,
    assigneeId: row.assignee_id || undefined,
    reviewerId: row.reviewer_id || undefined,
    dueDate: row.due_date || undefined,
    startedAt: row.started_at || undefined,
    completedAt: row.completed_at || undefined,
    gitlabUrl: row.gitlab_url || undefined,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    commentCount: row.comment_count,
    attachmentCount: 0,
    deployments: [],
    sprintId: row.sprint_id || undefined,
    department: row.department || undefined,
    tagIds: row.tag_ids ? (Array.isArray(row.tag_ids) ? row.tag_ids : (() => { try { return JSON.parse((row.tag_ids as string) || '[]'); } catch { return []; } })()) : undefined,
    parentTaskId: row.parent_task_id || undefined,
    approvalStatus: row.approval_status ?? undefined,
    currentApprovalId: row.current_approval_id ?? undefined,
    requiresApproval: row.requires_approval ?? false,
  };
}

export function mapUser(row: MemberRow): User {
  return { id: row.id, name: row.name, avatar: row.avatar, role: row.role, jobTitle: row.job_title, color: row.color, email: row.email, isActive: row.is_active !== false, sortOrder: row.sort_order ?? 99 };
}

export function mapStatus(row: Tables<'statuses'>): Status {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sort_order, isDone: row.is_done, autoStart: row.auto_start, autoDone: row.auto_done };
}

export function mapProductLine(row: Tables<'product_lines'>): ProductLine {
  return { id: row.id, name: row.name, icon: row.icon, color: row.color, sortOrder: row.sort_order };
}

export function mapProject(row: Tables<'projects'>): Project {
  return { id: row.id, lineId: row.line_id, name: row.name, key: row.key, color: row.color, isArchived: row.is_archived };
}

export function mapTaskSpec(row: Tables<'task_specs'>): TaskSpec {
  return { id: row.id, taskId: row.task_id, background: row.background, requirement: row.requirement, notes: row.notes };
}

export function mapTaskCheck(row: Tables<'task_checks'>): TaskCheck {
  return { id: row.id, taskId: row.task_id, text: row.text, isDone: row.is_done, sortOrder: row.sort_order };
}

export function mapTaskTodo(row: Tables<'task_todos'>): TaskTodo {
  return { id: row.id, taskId: row.task_id, text: row.text, isDone: row.is_done, sortOrder: row.sort_order };
}

export function mapComment(row: Tables<'comments'>): Comment {
  return { id: row.id, taskId: row.task_id, userId: row.user_id, content: row.content, createdAt: row.created_at, attachmentUrl: row.attachment_url || undefined, attachmentName: row.attachment_name || undefined, attachmentSize: row.attachment_size || undefined };
}

export function mapStatusLog(row: Tables<'status_logs'>): StatusLog {
  return { id: row.id, taskId: row.task_id, fromStatusId: row.from_status_id || undefined, toStatusId: row.to_status_id, changedBy: row.changed_by, changedAt: row.changed_at };
}

export function mapTag(row: TagRow): Tag {
  return { id: row.id, name: row.name, color: row.color };
}

export function mapCustomField(row: CustomFieldRow): CustomField {
  return {
    id: row.id,
    projectId: row.project_id,
    fieldName: row.field_name,
    fieldType: row.field_type as CustomField['fieldType'],
    options: row.options ? (Array.isArray(row.options) ? (row.options as string[]) : (() => { try { return JSON.parse(row.options as string); } catch { return []; } })()) : undefined,
    isRequired: row.is_required,
    defaultValue: row.default_value || undefined,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export function mapCustomFieldValue(row: CustomFieldValueRow): TaskCustomFieldValue {
  return {
    id: row.id,
    taskId: row.task_id,
    fieldId: row.field_id,
    valueText: row.value_text ?? undefined,
    valueNumber: row.value_number !== null && row.value_number !== undefined ? Number(row.value_number) : undefined,
    valueDate: row.value_date ?? undefined,
    valueBoolean: row.value_boolean !== null && row.value_boolean !== undefined ? Boolean(row.value_boolean) : undefined,
    valueUserId: row.value_user_id ?? undefined,
  };
}

export function mapTaskTemplate(row: TaskTemplateRow): TaskTemplate {
  return {
    id: row.id,
    projectId: row.project_id || null,
    name: row.name,
    description: row.description || '',
    defaultPriority: (row.default_priority as TaskTemplate['defaultPriority']) || null,
    defaultTagIds: row.default_tag_ids ? (Array.isArray(row.default_tag_ids) ? row.default_tag_ids : (() => { try { return JSON.parse((row.default_tag_ids as unknown as string) || '[]'); } catch { return []; } })()) : [],
    defaultSpecBackground: row.default_spec_background || '',
    defaultSpecRequirement: row.default_spec_requirement || '',
    defaultSpecNotes: row.default_spec_notes || '',
    defaultCheckItems: row.default_check_items || [],
    defaultTodoItems: row.default_todo_items || [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapTaskDependency(row: TaskDependencyRow): TaskDependency {
  return {
    id: row.id,
    taskId: row.task_id,
    dependsOnTaskId: row.depends_on_task_id,
    dependencyType: row.dependency_type,
    createdAt: row.created_at,
  };
}