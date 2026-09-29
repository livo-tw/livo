import type { Task } from '@/types';
import type { ApprovalRequest, ApprovalRuleStep } from '@/lib/approvalQueries';
import type { SlackBlock } from '@/lib/slackBlockBuilder';
import { taskUrl, priorityLabel } from '@/lib/slackBlockBuilder';
import i18n from '@/i18n';

/**
 * @param tokenHash - A one-time interaction token hash stored in the interaction_tokens table.
 *   The Slack interaction edge function validates this token and maps it back to the request ID.
 *   If omitted (fallback), the raw request.id is used — less secure but still functional.
 *   TODO: always pass tokenHash once the slack-interaction edge function validates tokens.
 */
export function buildApprovalRequestBlocks(
  task: Task,
  request: ApprovalRequest,
  steps: ApprovalRuleStep[],
  tokenHash?: string,
): SlackBlock[] {
  const stepSummary = steps
    .map(s => i18n.t('approval.slack.stepLabel', { order: s.step_order, type: s.approver_type === 'role' ? s.approver_role : i18n.t('approval.slack.designatedMember') }))
    .join('　|　');

  // Use the secure token hash as the button value; fallback to request.id if token not available.
  const buttonValue = tokenHash ?? request.id;

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:writing_hand: ${i18n.t('approval.slack.requestHeader')}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${taskUrl(task.id)}|${task.taskKey} ${task.title}>*\n${i18n.t('approval.slack.priorityLabel', { priority: priorityLabel(task.priority) })}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${i18n.t('approval.slack.statusTransition')}*${request.from_status}* → *${request.to_status}*` },
        { type: 'mrkdwn', text: i18n.t('approval.slack.layersLabel', { layers: stepSummary || i18n.t('approval.slack.defaultLayer') }) },
      ],
    },
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `:white_check_mark: ${i18n.t('approval.slack.approveButton')}`, emoji: true },
          action_id: 'approval_approve',
          value: buttonValue,
          style: 'primary',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: `:x: ${i18n.t('approval.slack.rejectButton')}`, emoji: true },
          action_id: 'approval_reject',
          value: buttonValue,
          style: 'danger',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: `:leftwards_arrow_with_hook: ${i18n.t('approval.slack.returnButton')}`, emoji: true },
          action_id: 'approval_return',
          value: buttonValue,
        },
      ],
    },
  ];
}

export function buildApprovalCompletedBlocks(
  task: Task,
  action: 'approve' | 'reject' | 'return',
  result: { actorName: string; comment?: string },
): SlackBlock[] {
  const resultMap = {
    approve: { emoji: ':white_check_mark:', label: i18n.t('approval.slack.approvedLabel') },
    reject: { emoji: ':x:', label: i18n.t('approval.slack.rejectedLabel') },
    return: { emoji: ':leftwards_arrow_with_hook:', label: i18n.t('approval.slack.returnedLabel') },
  };
  const r = resultMap[action];

  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${r.emoji} *${r.label}* — <${taskUrl(task.id)}|${task.taskKey} ${task.title}>\n${i18n.t('approval.slack.actedBy', { name: result.actorName })}`,
      },
    },
  ];

  if (result.comment) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: i18n.t('approval.slack.remarkLabel', { comment: result.comment }) }],
    });
  }

  return blocks;
}

export function buildPendingListBlocks(
  approvals: Array<{ request: ApprovalRequest; taskTitle: string; taskKey: string }>,
): SlackBlock[] {
  if (approvals.length === 0) {
    return [{
      type: 'section',
      text: { type: 'mrkdwn', text: `:white_check_mark: ${i18n.t('approval.slack.noPending')}` },
    }];
  }

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `:writing_hand: ${i18n.t('approval.slack.pendingListTitle')}`, emoji: true },
    },
  ];

  approvals.slice(0, 10).forEach(({ request, taskTitle, taskKey }) => {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${taskKey} ${taskTitle}*\n${request.from_status} → ${request.to_status}`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: i18n.t('approval.slack.processButton'), emoji: true },
        action_id: 'approval_approve',
        value: request.id,
        style: 'primary',
      },
    });
  });

  if (approvals.length > 10) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: i18n.t('approval.slack.morePending', { count: approvals.length - 10 }) }],
    });
  }

  return blocks;
}
