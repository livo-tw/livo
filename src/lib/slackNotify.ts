import { loadFeatureToggles } from '@/lib/featureToggleQueries';
import { isApprovalEvent } from '@/lib/featureToggles';
import { supabase } from '@/integrations/supabase/client';
import {
  buildTaskNotificationBlocks,
  type SlackBlock,
} from '@/lib/slackBlockBuilder';
import {
  buildApprovalRequestBlocks,
  buildApprovalCompletedBlocks,
} from '@/lib/slackApprovalBlocks';
import { threadMappingQueries, tokenQueries } from '@/lib/integrationQueries';
import type { Task } from '@/types';
import type { ApprovalRequest, ApprovalRuleStep } from '@/lib/approvalQueries';

interface SlackNotifyPayload {
  type: 'task_created' | 'status_changed' | 'assignee_changed' | 'comment_added' | 'priority_changed';
  taskKey: string;
  taskTitle: string;
  taskId: string;
  projectName?: string;
  actorName: string;
  // Common context
  priority?: string;
  assigneeName?: string;
  statusName?: string;
  dueDate?: string;
  // status_changed
  fromStatus?: string;
  toStatus?: string;
  // assignee_changed
  oldAssignee?: string;
  newAssignee?: string;
  // comment_added
  commentPreview?: string;
  // DM targets — edge function will resolve
  dmTargetUserIds?: string[];
  // Optional custom message
  customMessage?: string;
}

/**
 * Invoke the Supabase Edge Function `slack-notify` with the given payload.
 * Fire-and-forget: errors are logged but never thrown to the UI.
 */
export async function sendSlackNotify(payload: SlackNotifyPayload): Promise<void> {
  try {
    const blocks = buildTaskNotificationBlocks(
      payload as unknown as Task & Record<string, unknown>,
      payload.type,
      {
        actorName: payload.actorName,
        fromStatus: payload.fromStatus,
        toStatus: payload.toStatus,
        commentPreview: payload.commentPreview,
        template: payload.customMessage,
      },
    );
    await supabase.functions.invoke('slack-notify', {
      body: { ...payload, blocks },
    });
  } catch (err) {
    console.error('[LIVO] Slack 通知發送失敗:', err);
  }
}

/**
 * Send a report digest to Slack (async, fire-and-forget).
 */
export async function sendSlackReportAsync(
  content: string,
  title: string,
  reportType: string,
  channelTarget?: string,
  eventType?: string,
): Promise<void> {
  try {
    if (eventType && isApprovalEvent(eventType) && !(await loadFeatureToggles()).approvals) return;
    await supabase.functions.invoke('slack-notify', {
      body: {
        type: 'report',
        reportContent: content,
        reportTitle: title,
        reportType,
        channelTarget,
        eventType,
      },
    });
  } catch (err) {
    console.error('[LIVO] Slack 報告發送失敗:', err);
  }
}

/**
 * Send an approval request notification to Slack.
 */
export async function sendSlackApprovalRequest(
  task: Task,
  request: ApprovalRequest,
  steps: ApprovalRuleStep[],
): Promise<void> {
  try {
    if (!(await loadFeatureToggles()).approvals) return;
    const blocks = buildApprovalRequestBlocks(task, request, steps);
    await supabase.functions.invoke('slack-notify', {
      body: {
        type: 'approval_request',
        taskId: task.id,
        taskKey: task.taskKey,
        taskTitle: task.title,
        requestId: request.id,
        blocks,
      },
    });
  } catch (err) {
    console.error('[LIVO] Slack 簽核請求通知失敗:', err);
  }
}

/**
 * Send an approval completed/rejected/returned notification to Slack.
 */
export async function sendSlackApprovalCompleted(
  task: Task,
  action: 'approve' | 'reject' | 'return',
  context: { actorName: string; comment?: string },
): Promise<void> {
  try {
    if (!(await loadFeatureToggles()).approvals) return;
    const blocks = buildApprovalCompletedBlocks(task, action, context);
    await supabase.functions.invoke('slack-notify', {
      body: {
        type: 'approval_completed',
        taskId: task.id,
        taskKey: task.taskKey,
        taskTitle: task.title,
        action,
        blocks,
      },
    });
  } catch (err) {
    console.error('[LIVO] Slack 簽核完成通知失敗:', err);
  }
}
