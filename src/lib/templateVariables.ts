/**
 * Shared template variable utilities for notification templates & work report templates.
 *
 * Storage format:  {{task_name}}
 * Display format:  【任務名稱】  (Chinese-bracket wrapped label)
 *
 * Conversion is bidirectional so the textarea shows friendly labels while
 * the database always stores the canonical {{key}} form.
 */
import i18n from '@/i18n';

// ── Notification template variables ─────────────────────────────────────────

export const NOTIF_VAR_KEYS = [
  'task_name', 'task_url', 'assignee', 'reporter',
  'project_name', 'status', 'prev_status', 'priority',
  'due_date', 'due_remaining', 'overdue_days',
  'description_summary', 'approver', 'subtask_progress',
  'assigner_name', 'changer_name', 'requester_name', 'approver_name',
] as const;

export type NotifVarKey = (typeof NOTIF_VAR_KEYS)[number];

/** i18n key for each notification variable label */
const NOTIF_I18N: Record<NotifVarKey, string> = {
  task_name:           'templateVar.taskName',
  task_url:            'templateVar.taskUrl',
  assignee:            'templateVar.assignee',
  reporter:            'templateVar.reporter',
  project_name:        'templateVar.projectName',
  status:              'templateVar.status',
  prev_status:         'templateVar.prevStatus',
  priority:            'templateVar.priority',
  due_date:            'templateVar.dueDate',
  due_remaining:       'templateVar.dueRemaining',
  overdue_days:        'templateVar.overdueDays',
  description_summary: 'templateVar.descriptionSummary',
  approver:            'templateVar.approver',
  subtask_progress:    'templateVar.subtaskProgress',
  assigner_name:       'templateVar.assignerName',
  changer_name:        'templateVar.changerName',
  requester_name:      'templateVar.requesterName',
  approver_name:       'templateVar.approverName',
};

export type NotifGroup = 'task' | 'people' | 'time' | 'link' | 'other';

export const NOTIF_GROUPS: { group: NotifGroup; keys: NotifVarKey[] }[] = [
  { group: 'task',   keys: ['task_name', 'project_name', 'status', 'prev_status', 'priority'] },
  { group: 'people', keys: ['assignee', 'reporter', 'assigner_name', 'changer_name', 'requester_name', 'approver_name', 'approver'] },
  { group: 'time',   keys: ['due_date', 'due_remaining', 'overdue_days'] },
  { group: 'link',   keys: ['task_url'] },
  { group: 'other',  keys: ['description_summary', 'subtask_progress'] },
];

export function getNotifLabel(key: NotifVarKey): string {
  return i18n.t(NOTIF_I18N[key]);
}

export function getNotifGroupLabel(group: NotifGroup): string {
  return i18n.t(`templateVar.group.${group}`);
}

/** Build key→label map for notification variables */
function notifKeyToLabel(): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of NOTIF_VAR_KEYS) m.set(k, i18n.t(NOTIF_I18N[k]));
  return m;
}

/** Build label→key reverse map */
function notifLabelToKey(): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of NOTIF_VAR_KEYS) m.set(i18n.t(NOTIF_I18N[k]), k);
  return m;
}

/** Storage → display: {{task_name}} → 【任務名稱】 */
export function notifToDisplay(content: string): string {
  const map = notifKeyToLabel();
  return content.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    const label = map.get(key);
    return label ? `【${label}】` : m;
  });
}

/** Display → storage: 【任務名稱】 → {{task_name}} */
export function notifToStorage(content: string): string {
  const map = notifLabelToKey();
  return content.replace(/【([^】]+)】/g, (m, label: string) => {
    const key = map.get(label);
    return key ? `{{${key}}}` : m;
  });
}

// ── Work report template variables ──────────────────────────────────────────

export const REPORT_VAR_KEYS = [
  'completed_tasks', 'in_progress_tasks', 'overdue_tasks', 'upcoming_deadlines', 'all_tasks',
  'task_count', 'completed_count', 'in_progress_count', 'overdue_count',
  'date',
] as const;

export type ReportVarKey = (typeof REPORT_VAR_KEYS)[number];

const REPORT_I18N: Record<ReportVarKey, string> = {
  completed_tasks:    'autoReport.variables.completedTasks',
  in_progress_tasks:  'autoReport.variables.inProgressTasks',
  overdue_tasks:      'autoReport.variables.overdueTasks',
  upcoming_deadlines: 'autoReport.variables.upcomingDeadlines',
  all_tasks:          'autoReport.variables.allTasks',
  task_count:         'autoReport.variables.taskCount',
  completed_count:    'autoReport.variables.completedCount',
  in_progress_count:  'autoReport.variables.inProgressCount',
  overdue_count:      'autoReport.variables.overdueCount',
  date:               'autoReport.variables.date',
};

export type ReportGroup = 'taskList' | 'stats' | 'other';

export const REPORT_GROUPS: { group: ReportGroup; keys: ReportVarKey[] }[] = [
  { group: 'taskList', keys: ['completed_tasks', 'in_progress_tasks', 'overdue_tasks', 'upcoming_deadlines', 'all_tasks'] },
  { group: 'stats',    keys: ['task_count', 'completed_count', 'in_progress_count', 'overdue_count'] },
  { group: 'other',    keys: ['date'] },
];

export function getReportLabel(key: ReportVarKey): string {
  return i18n.t(REPORT_I18N[key]);
}

export function getReportGroupLabel(group: ReportGroup): string {
  return i18n.t(`templateVar.reportGroup.${group}`);
}

function reportKeyToLabel(): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of REPORT_VAR_KEYS) m.set(k, i18n.t(REPORT_I18N[k]));
  return m;
}

function reportLabelToKey(): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of REPORT_VAR_KEYS) m.set(i18n.t(REPORT_I18N[k]), k);
  return m;
}

/** Storage → display for report variables */
export function reportToDisplay(content: string): string {
  const map = reportKeyToLabel();
  return content.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
    const label = map.get(key);
    return label ? `【${label}】` : m;
  });
}

/** Display → storage for report variables */
export function reportToStorage(content: string): string {
  const map = reportLabelToKey();
  return content.replace(/【([^】]+)】/g, (m, label: string) => {
    const key = map.get(label);
    return key ? `{{${key}}}` : m;
  });
}
