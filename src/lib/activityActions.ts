/** Names for the action codes in activity_logs. */
const ACTION_LABEL_KEYS: Record<string, string> = {
  create_task: 'activity.createTask',
  update_title: 'activity.updateTitle',
  update_status: 'activity.updateStatus',
  update_priority: 'activity.updatePriority',
  update_assignee: 'activity.updateAssignee',
  update_reviewer: 'activity.updateReviewer',
  update_project: 'activity.updateProject',
  update_due_date: 'activity.updateDueDate',
  update_department: 'activity.updateDepartment',
  update_spec: 'activity.updateSpec',
  add_comment: 'activity.addComment',
  delete_comment: 'activity.deleteComment',
  add_check: 'activity.addCheck',
  toggle_check: 'activity.toggleCheck',
  delete_check: 'activity.deleteCheck',
  add_todo: 'activity.addTodo',
  toggle_todo: 'activity.toggleTodo',
  delete_todo: 'activity.deleteTodo',
  upload_file: 'activity.uploadFile',
  delete_file: 'activity.deleteFile',
  delete_task: 'activity.deleteTask',
  login: 'activity.login',
  logout: 'activity.logout',
  update_deploy: 'activity.updateDeploy',
  complete_sprint: 'activityLog.completeSprint',
  start_sprint: 'activityLog.startSprint',
  start_standup: 'activityLog.startStandup',
  gantt_date_change: 'activityLog.ganttDateChange',
  cleanup_logs: 'activityLog.cleanupLogs',
  manual_backup: 'activityLog.manualBackup',
  import_jira: 'activityLog.importJira',
  restore_backup: 'activityLog.restoreBackup',
  add_member: 'activityLog.addMember',
  delete_member: 'activityLog.deleteMember',
  change_role: 'activityLog.changeRole',
  toggle_member: 'activityLog.toggleMember',
  reset_password: 'activityLog.resetPassword',
  create_login: 'activityLog.createLogin',
  add_status: 'activityLog.addStatus',
  update_status_name: 'activityLog.updateStatusName',
  delete_status: 'activityLog.deleteStatus',
  add_product_line: 'activityLog.addProductLine',
  update_product_line: 'activityLog.updateProductLine',
  add_project: 'activityLog.addProject',
  update_project_info: 'activityLog.updateProjectInfo',
  delete_project: 'activityLog.deleteProject',
  update_team_intro: 'activityLog.updateTeamIntro',
};

/** Actions named under activityLog.extra (written by the app, Slack and the approval server). */
const EXTRA_ACTIONS = new Set(['add_tag', 'remove_tag', 'delete_tag', 'approval_rule_created', 'approval_rule_updated', 'approval_rule_deleted', 'bulk_assign', 'bulk_update_priority', 'bulk_update_status', 'change_job_title', 'delete_product_line', 'edit_comment', 'end_standup', 'export_csv', 'mention', 'notification_rule_created', 'notification_rule_deleted', 'notification_rule_toggled', 'notification_template_created', 'notification_template_updated', 'notification_template_deleted', 'unlink_parent', 'create', 'approval_requested', 'approval_step_approved', 'approval_approved', 'approval_rejected', 'approval_returned', 'approval_withdrawn', 'approval_cancelled', 'approval_requirement_changed']);

/**
 * The translation key for a recorded action. Every action has a name; an unknown
 * one (written by a newer server) reads as "other", never as a raw code.
 */
export function activityActionLabelKey(action: string): string {
  if (action === 'task_work') return 'taskWork.activity';
  return ACTION_LABEL_KEYS[action] ?? (EXTRA_ACTIONS.has(action) ? `activityLog.extra.${action}` : 'activityLog.otherAction');
}
