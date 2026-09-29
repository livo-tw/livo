import i18n from '@/i18n';
import { ReportConfig } from './types';

export const DEFAULT_DAILY: ReportConfig = {
  reportType: 'daily', enabled: false, hour: 17, minute: 30, weekday: 1,
  templateKey: 'default_daily', customTemplate: '',
  scope: 'assigned_to_me', scopeProjectIds: [], sendTarget: 'dm', sendChannel: '',
};

export const DEFAULT_WEEKLY: ReportConfig = {
  reportType: 'weekly', enabled: false, hour: 16, minute: 0, weekday: 5,
  templateKey: 'default_weekly', customTemplate: '',
  scope: 'assigned_to_me', scopeProjectIds: [], sendTarget: 'dm', sendChannel: '',
};

export const getWeekdays = () => [
  i18n.t('slackNotify.weekdays.sun'),
  i18n.t('slackNotify.weekdays.mon'),
  i18n.t('slackNotify.weekdays.tue'),
  i18n.t('slackNotify.weekdays.wed'),
  i18n.t('slackNotify.weekdays.thu'),
  i18n.t('slackNotify.weekdays.fri'),
  i18n.t('slackNotify.weekdays.sat'),
];

/** @deprecated Use REPORT_GROUPS from templateVariables.ts instead */
export const getTemplateVariables = () => [
  { var: '{{completed_tasks}}', desc: i18n.t('autoReport.variables.completedTasks') },
  { var: '{{in_progress_tasks}}', desc: i18n.t('autoReport.variables.inProgressTasks') },
  { var: '{{overdue_tasks}}', desc: i18n.t('autoReport.variables.overdueTasks') },
  { var: '{{upcoming_deadlines}}', desc: i18n.t('autoReport.variables.upcomingDeadlines') },
  { var: '{{all_tasks}}', desc: i18n.t('autoReport.variables.allTasks') },
  { var: '{{date}}', desc: i18n.t('autoReport.variables.date') },
  { var: '{{task_count}}', desc: i18n.t('autoReport.variables.taskCount') },
  { var: '{{completed_count}}', desc: i18n.t('autoReport.variables.completedCount') },
  { var: '{{in_progress_count}}', desc: i18n.t('autoReport.variables.inProgressCount') },
  { var: '{{overdue_count}}', desc: i18n.t('autoReport.variables.overdueCount') },
];

/** Default custom template content (storage format) */
export const DEFAULT_CUSTOM_TEMPLATE =
  '【{{date}} 工作日報】\n\n' +
  '已完成（{{completed_count}}）\n{{completed_tasks}}\n\n' +
  '進行中（{{in_progress_count}}）\n{{in_progress_tasks}}\n\n' +
  '已逾期（{{overdue_count}}）\n{{overdue_tasks}}\n\n' +
  '即將到期\n{{upcoming_deadlines}}\n\n' +
  '---\n任務總數：{{task_count}}';
