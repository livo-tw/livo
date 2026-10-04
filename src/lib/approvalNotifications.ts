// Approval notifications are stored differently per backend:
//   Cloud (worker/schema.sql trigger) → JSON {kind:'approval', requestId, taskTitle, operation, version}
//   Docker (20261009_atomic_approval_commands.sql) → plain text "KEY - Title [event]"
// Plain text is shown as-is; the JSON is turned into a readable line here.

export interface ApprovalNotificationContent {
  kind: 'approval';
  requestId: string;
  taskTitle: string;
  operation: string;
}

const OPERATION_KEYS: Record<string, string> = {
  submit: 'notification.approval.submit',
  approve: 'notification.approval.approve',
  reject: 'notification.approval.reject',
  return: 'notification.approval.return',
  withdraw: 'notification.approval.withdraw',
};

export function parseApprovalNotification(content: string | null | undefined): ApprovalNotificationContent | null {
  if (!content || content.trimStart()[0] !== '{') return null;
  try {
    const value = JSON.parse(content);
    if (!value || value.kind !== 'approval' || typeof value.taskTitle !== 'string') return null;
    return {
      kind: 'approval',
      requestId: typeof value.requestId === 'string' ? value.requestId : '',
      taskTitle: value.taskTitle.slice(0, 200),
      operation: typeof value.operation === 'string' ? value.operation : '',
    };
  } catch {
    return null;
  }
}

/** "Approved: Task title" in the current language. */
export function formatApprovalNotification(value: ApprovalNotificationContent, t: (key: string, options?: Record<string, unknown>) => string): string {
  const action = t(OPERATION_KEYS[value.operation] || 'notification.approval.updated');
  return value.taskTitle ? t('notification.approval.withTitle', { action, title: value.taskTitle }) : action;
}
