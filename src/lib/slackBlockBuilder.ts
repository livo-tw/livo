import type { Task } from '@/types';
import i18n from '@/i18n';

// Block Kit primitive types (subset used by LIVO)
interface TextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface SectionBlock {
  type: 'section';
  text: TextObject;
  accessory?: ButtonElement | StaticSelectElement;
}

interface DividerBlock {
  type: 'divider';
}

interface ContextBlock {
  type: 'context';
  elements: TextObject[];
}

interface ActionsBlock {
  type: 'actions';
  elements: Array<ButtonElement | StaticSelectElement>;
}

interface HeaderBlock {
  type: 'header';
  text: TextObject;
}

interface ButtonElement {
  type: 'button';
  text: TextObject;
  action_id: string;
  value?: string;
  style?: 'primary' | 'danger';
  url?: string;
}

interface StaticSelectElement {
  type: 'static_select';
  placeholder: TextObject;
  action_id: string;
  options: Array<{ text: TextObject; value: string }>;
}

export type SlackBlock =
  | SectionBlock
  | DividerBlock
  | ContextBlock
  | ActionsBlock
  | HeaderBlock;

const PRIORITY_EMOJI: Record<string, string> = {
  highest: ':red_circle:',
  high: ':orange_circle:',
  medium: ':yellow_circle:',
  low: ':blue_circle:',
  lowest: ':white_circle:',
};

export function taskUrl(taskId: string): string {
  return `${typeof window !== 'undefined' ? window.location.origin : 'https://livo-tw.com'}/demo/task/${taskId}`;
}

export function priorityLabel(priority: string): string {
  const labels: Record<string, string> = {
    highest: i18n.t('slack.priority.highest'),
    high: i18n.t('slack.priority.high'),
    medium: i18n.t('slack.priority.medium'),
    low: i18n.t('slack.priority.low'),
    lowest: i18n.t('slack.priority.lowest'),
  };
  return `${PRIORITY_EMOJI[priority] ?? ''} ${labels[priority] ?? priority}`;
}

// --- Public builders ---

export function buildTaskNotificationBlocks(
  task: Task,
  event: string,
  context: {
    actorName?: string;
    fromStatus?: string;
    toStatus?: string;
    commentPreview?: string;
    template?: string;
  },
): SlackBlock[] {
  const eventLabels: Record<string, string> = {
    task_created: `:new: ${i18n.t('slack.event.taskCreated')}`,
    status_changed: `:arrows_counterclockwise: ${i18n.t('slack.event.statusChanged')}`,
    assignee_changed: `:bust_in_silhouette: ${i18n.t('slack.event.assigneeChanged')}`,
    comment_added: `:speech_balloon: ${i18n.t('slack.event.commentAdded')}`,
    priority_changed: `:exclamation: ${i18n.t('slack.event.priorityChanged')}`,
    approval_requested: `:writing_hand: ${i18n.t('slack.event.approvalRequested')}`,
    approval_completed: `:white_check_mark: ${i18n.t('slack.event.approvalCompleted')}`,
  };

  let detail = context.template ?? '';
  if (!detail) {
    if (event === 'status_changed' && context.fromStatus && context.toStatus) {
      detail = `*${context.fromStatus}* → *${context.toStatus}*`;
    } else if (event === 'comment_added' && context.commentPreview) {
      detail = context.commentPreview;
    }
  }

  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${eventLabels[event] ?? event}\n*<${taskUrl(task.id)}|${task.taskKey} ${task.title}>*${detail ? `\n${detail}` : ''}`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: priorityLabel(task.priority) },
        ...(context.actorName ? [{ type: 'mrkdwn' as const, text: i18n.t('slack.byActor', { name: context.actorName }) }] : []),
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: `:eyes: ${i18n.t('slack.viewTask')}`, emoji: true },
          action_id: 'task_view',
          value: task.id,
          url: taskUrl(task.id),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: `:pencil: ${i18n.t('slack.openInLivo')}`, emoji: true },
          action_id: 'task_open_livo',
          value: task.id,
          url: taskUrl(task.id),
        },
      ],
    },
  ];
}

export function buildTaskSummaryBlocks(task: Task): SlackBlock[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*<${taskUrl(task.id)}|${task.taskKey} ${task.title}>*`,
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${i18n.t('slack.priorityField')}${priorityLabel(task.priority)}` },
        ...(task.dueDate ? [{ type: 'mrkdwn' as const, text: `${i18n.t('slack.dueDate')}${task.dueDate}` }] : []),
        ...(task.approvalStatus ? [{ type: 'mrkdwn' as const, text: `${i18n.t('slack.approvalStatus')}${task.approvalStatus}` }] : []),
      ],
    },
  ];
}

