import type { TFunction } from 'i18next';
import type { EventType, Tone } from '@/lib/notificationQueries';
import { NOTIF_VAR_KEYS } from '@/lib/templateVariables';

/**
 * Events a notification rule can be created for. NotificationToastProvider only
 * fires rules for status changes, so other events are not offered.
 */
export const RULE_EVENT_TYPES: EventType[] = ['status_changed'];

/** Whether the runtime ever fires a rule for this event. */
export const ruleEventFires = (event: string) => (RULE_EVENT_TYPES as string[]).includes(event);

/** i18n keys for event type labels */
export const EVENT_LABEL_KEYS: Record<EventType, string> = {
  task_created:       'notificationRules.events.taskCreated',
  status_changed:     'notificationRules.events.statusChanged',
  assignee_changed:   'notificationRules.events.assigneeChanged',
  due_reminder:       'notificationRules.events.dueReminder',
  overdue:            'notificationRules.events.overdue',
  approval_requested: 'notificationRules.events.approvalRequested',
  approval_completed: 'notificationRules.events.approvalCompleted',
  comment_added:      'notificationRules.events.commentAdded',
  custom:             'notificationRules.events.custom',
};

export const EVENT_TYPES = Object.keys(EVENT_LABEL_KEYS) as EventType[];

/** Label for an event type; unknown values are shown as-is. */
export function eventLabel(t: TFunction, event: string): string {
  const key = EVENT_LABEL_KEYS[event as EventType];
  return key ? t(key) : event;
}

/** i18n keys for tone labels */
export const TONE_LABEL_KEYS: Record<Tone, string> = {
  neutral:     'notificationRules.tones.neutral',
  celebration: 'notificationRules.tones.celebration',
  urgent:      'notificationRules.tones.urgent',
  warning:     'notificationRules.tones.warning',
  friendly:    'notificationRules.tones.friendly',
};

export const TONES = Object.keys(TONE_LABEL_KEYS) as Tone[];

/** Label for a tone; unknown values are shown as-is. */
export function toneLabel(t: TFunction, tone: string): string {
  const key = TONE_LABEL_KEYS[tone as Tone];
  return key ? t(key) : tone;
}

/** i18n keys for the default template content per event type (storage format) */
const DEFAULT_CONTENT_KEYS: Record<EventType, string> = {
  task_created:       'notificationRules.defaultContent.taskCreated',
  status_changed:     'notificationRules.defaultContent.statusChanged',
  assignee_changed:   'notificationRules.defaultContent.assigneeChanged',
  due_reminder:       'notificationRules.defaultContent.dueReminder',
  overdue:            'notificationRules.defaultContent.overdue',
  approval_requested: 'notificationRules.defaultContent.approvalRequested',
  approval_completed: 'notificationRules.defaultContent.approvalCompleted',
  comment_added:      'notificationRules.defaultContent.commentAdded',
  custom:             'notificationRules.defaultContent.custom',
};

/** Maps every template variable to its own {{key}} so i18next leaves them in place. */
const KEEP_VARIABLES = Object.fromEntries(NOTIF_VAR_KEYS.map(k => [k, `{{${k}}}`]));

/** Default template content for an event, in storage format ({{key}} placeholders). */
export function getDefaultContent(t: TFunction, eventType: EventType): string {
  return t(DEFAULT_CONTENT_KEYS[eventType], { replace: KEEP_VARIABLES });
}

/** Sample values for previewing a template */
export function buildPreviewContext(t: TFunction): Record<string, string> {
  const assignee = t('notificationRules.sample.assignee');
  const reporter = t('notificationRules.sample.reporter');
  const approver = t('notificationRules.sample.approver');
  return {
    task_name:           t('notificationRules.sample.taskName'),
    task_url:            'https://livo-tw.com/demo/?task=123',
    assignee,
    reporter,
    project_name:        'LIVO v2',
    status:              t('notificationRules.sample.status'),
    prev_status:         t('notificationRules.sample.prevStatus'),
    priority:            'high',
    due_date:            '2026-04-10',
    due_remaining:       '8',
    overdue_days:        '2',
    description_summary: t('notificationRules.sample.descriptionSummary'),
    approver,
    subtask_progress:    '3/5',
    assigner_name:       reporter,
    changer_name:        assignee,
    requester_name:      assignee,
    approver_name:       approver,
  };
}
