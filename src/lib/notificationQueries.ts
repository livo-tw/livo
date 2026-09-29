import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/integrations/supabase/types';
import type { Task } from '@/types';
import type { TemplateContext } from '@/hooks/useNotificationTemplates';

import { fromTable } from './supabaseQuery';

type DB = SupabaseClient<Database>;
const q = fromTable;

export type EventType =
  | 'task_created' | 'status_changed' | 'assignee_changed'
  | 'due_reminder' | 'overdue' | 'approval_requested' | 'approval_completed'
  | 'comment_added' | 'custom';

export type Tone = 'neutral' | 'celebration' | 'urgent' | 'warning' | 'friendly';

export interface NotificationTemplate {
  id: string;
  organization_id?: string | null;
  name: string;
  event_type: EventType;
  template_content: string;
  tone: Tone;
  is_default: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRule {
  id: string;
  project_id: string | null;
  event_type: EventType;
  from_status: string | null;
  to_status: string | null;
  is_enabled: boolean;
  template_id: string | null;
  target_channels: Array<{ type: string; target: string }>;
  priority_overrides: Record<string, unknown>;
  auto_send: boolean;
  auto_send_delay_seconds: number;
  created_at: string;
  updated_at: string;
}

export interface NotificationDeliveryLog {
  id: string;
  rule_id: string | null;
  task_id: string | null;
  event_type: EventType;
  triggered_by: string;
  message_content: string;
  was_customized: boolean;
  channel_type: string;
  channel_target: string;
  status: 'sent' | 'failed' | 'skipped';
  error_message: string | null;
  sent_at: string;
}

export interface DueDateReminder {
  id: string;
  task_id: string;
  remind_at: string;
  reminder_type: 'before_1day' | 'due_day' | 'overdue';
  is_sent: boolean;
  sent_at: string | null;
  created_at: string;
}

/** Shared context builder for notification template resolution */
export function buildNotificationContext(
  task: Task,
  fromStatus?: string,
  toStatus?: string,
): TemplateContext {
  return {
    task_name: task.title,
    task_url: `${window.location.origin}/demo/task/${task.id}`,
    assignee: task.assigneeId ?? '',
    priority: task.priority,
    due_date: task.dueDate ?? '',
    ...(toStatus !== undefined && { status: toStatus }),
    ...(fromStatus !== undefined && { prev_status: fromStatus }),
  };
}

export const templateQueries = {
  fetchAll: (db: DB) =>
    q(db, 'notification_templates').select('*').order('created_at'),
  fetchByEvent: (db: DB, eventType: EventType) =>
    q(db, 'notification_templates').select('*').eq('event_type', eventType),
  fetchDefaults: (db: DB) =>
    q(db, 'notification_templates').select('*').eq('is_default', true),
  create: (db: DB, data: Omit<NotificationTemplate, 'id' | 'created_at' | 'updated_at'>) =>
    q(db, 'notification_templates').insert(data).select().single(),
  update: (db: DB, id: string, data: Partial<NotificationTemplate>) =>
    q(db, 'notification_templates')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id).select().single(),
  delete: (db: DB, id: string) =>
    q(db, 'notification_templates').delete().eq('id', id),
};

export const ruleQueries = {
  fetchAll: (db: DB) =>
    q(db, 'notification_rules').select('*').order('created_at'),
  fetchByProject: (db: DB, projectId: string) =>
    q(db, 'notification_rules').select('*').eq('project_id', projectId),
  create: (db: DB, data: Omit<NotificationRule, 'id' | 'created_at' | 'updated_at'>) =>
    q(db, 'notification_rules').insert(data).select().single(),
  update: (db: DB, id: string, data: Partial<NotificationRule>) =>
    q(db, 'notification_rules')
      .update({ ...data, updated_at: new Date().toISOString() })
      .eq('id', id).select().single(),
  delete: (db: DB, id: string) =>
    q(db, 'notification_rules').delete().eq('id', id),
  toggle: (db: DB, id: string, enabled: boolean) =>
    q(db, 'notification_rules')
      .update({ is_enabled: enabled, updated_at: new Date().toISOString() })
      .eq('id', id).select().single(),
};

export const logQueries = {
  create: (db: DB, data: Omit<NotificationDeliveryLog, 'id' | 'sent_at'>) =>
    q(db, 'notification_delivery_logs').insert(data).select().single(),
  fetchByTask: (db: DB, taskId: string) =>
    q(db, 'notification_delivery_logs')
      .select('*').eq('task_id', taskId).order('sent_at', { ascending: false }),
  fetchRecent: (db: DB, limit = 50) =>
    q(db, 'notification_delivery_logs')
      .select('*').order('sent_at', { ascending: false }).limit(limit),
};

export const reminderQueries = {
  create: (db: DB, data: Omit<DueDateReminder, 'id' | 'created_at'>) =>
    q(db, 'due_date_reminders').insert(data).select().single(),
  fetchPending: (db: DB) =>
    q(db, 'due_date_reminders')
      .select('*').eq('is_sent', false).lte('remind_at', new Date().toISOString()),
  markSent: (db: DB, id: string) =>
    q(db, 'due_date_reminders')
      .update({ is_sent: true, sent_at: new Date().toISOString() }).eq('id', id),
};
