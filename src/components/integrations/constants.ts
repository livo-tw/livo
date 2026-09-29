import { SlackSettings, WebhookSettings, EmailSettings, GitLabSettings, CalendarSettings } from './types';

// Labels are i18n keys from integrations.events.*
// Resolved at render time using t() in EventCheckboxes or parent components
export const SLACK_EVENTS = [
  { value: 'task_created', labelKey: 'integrations.events.taskCreated' },
  { value: 'status_changed', labelKey: 'integrations.events.statusChanged' },
  { value: 'assignee_changed', labelKey: 'integrations.events.assigneeChanged' },
  { value: 'comment_added', labelKey: 'integrations.events.commentAdded' },
  { value: 'priority_changed', labelKey: 'integrations.events.priorityChanged' },
];

export const WEBHOOK_EVENTS = [
  { value: 'task_created', labelKey: 'integrations.events.taskCreated' },
  { value: 'status_changed', labelKey: 'integrations.events.statusChanged' },
  { value: 'task_completed', labelKey: 'integrations.events.taskCompleted' },
  { value: 'comment_added', labelKey: 'integrations.events.commentAdded' },
];

export const EMAIL_EVENTS = [
  { value: 'task_assigned', labelKey: 'integrations.events.taskAssigned' },
  { value: 'due_soon', labelKey: 'integrations.events.dueSoon' },
  { value: 'mentioned', labelKey: 'integrations.events.mentioned' },
];

export const DEFAULT_SLACK: SlackSettings = {
  enabled: false, webhookUrl: '', channel: '#general',
  events: ['task_created', 'status_changed', 'comment_added'],
};

export const DEFAULT_WEBHOOK: WebhookSettings = {
  enabled: false, url: '', secret: '',
  events: ['task_created', 'status_changed', 'task_completed'],
};

export const DEFAULT_EMAIL: EmailSettings = {
  enabled: false, smtpHost: '', smtpPort: 587, smtpUser: '', smtpPassword: '',
  fromName: 'LIVO', fromEmail: '', events: ['task_assigned', 'due_soon', 'mentioned'],
};

export const DEFAULT_GITLAB: GitLabSettings = {
  enabled: false, url: 'https://gitlab.com', accessToken: '', projectId: '',
};

export const DEFAULT_CALENDAR: CalendarSettings = {
  enabled: false, provider: 'google', calendarId: '', syncDueDates: true, syncStartDates: false,
};
