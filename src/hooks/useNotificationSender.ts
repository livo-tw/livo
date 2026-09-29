import { useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import {
  logQueries,
  buildNotificationContext,
  type NotificationRule,
  type NotificationDeliveryLog,
} from '@/lib/notificationQueries';
import { resolveTemplate } from './useNotificationTemplates';
import { sendSlackReportAsync } from '@/lib/slackNotify';
import type { Task } from '@/types';

const MERGE_WINDOW_MS = 5000;

interface PendingEntry {
  timer: ReturnType<typeof setTimeout>;
  messages: string[];
  logBase: Omit<NotificationDeliveryLog, 'id' | 'sent_at'>;
}

export function useNotificationSender(templates: Array<{ id: string; template_content: string }> = []) {
  const pending = useRef<Map<string, PendingEntry>>(new Map());

  // Clear all pending timers on unmount to avoid memory leaks / post-unmount state updates
  useEffect(() => {
    const pendingRef = pending.current;
    return () => {
      for (const entry of pendingRef.values()) {
        clearTimeout(entry.timer);
      }
      pendingRef.clear();
    };
  }, []);

  const flush = useCallback(async (channelKey: string) => {
    const entry = pending.current.get(channelKey);
    if (!entry) return;
    pending.current.delete(channelKey);

    const merged = entry.messages.length === 1
      ? entry.messages[0]
      : entry.messages.map((m, i) => `${i + 1}. ${m}`).join('\n');

    const { channel_type, channel_target } = entry.logBase;

    let status: 'sent' | 'failed' | 'skipped' = 'skipped';
    let errorMessage: string | null = null;

    if (channel_type === 'slack') {
      try {
        await sendSlackReportAsync(merged, merged, '', channel_target);
        status = 'sent';
      } catch (e) {
        status = 'failed';
        errorMessage = e instanceof Error ? e.message : 'Slack send failed';
        console.error('[LIVO] Slack notification send failed:', errorMessage);
      }
    } else {
      // TODO: implement LINE and webhook channel sending
      status = 'skipped';
      errorMessage = `channel type "${channel_type}" not yet implemented`;
    }

    const { error } = await logQueries.create(supabase, {
      ...entry.logBase,
      message_content: merged,
      status,
      error_message: errorMessage,
    });
    if (error) {
      console.error('[LIVO] Failed to write notification log:', (error as { message: string }).message);
    }
  }, []);

  const sendNotification = useCallback(async (
    rule: NotificationRule,
    task: Task,
    customMessage?: string,
    fromStatus?: string,
    toStatus?: string,
  ) => {
    const channels = rule.target_channels ?? [];
    if (channels.length === 0) return;

    const ctx = buildNotificationContext(task, fromStatus, toStatus);
    const templateContent = rule.template_id
      ? (templates.find(t => t.id === rule.template_id)?.template_content ?? task.title ?? '')
      : (task.title ?? '');
    const resolved = customMessage ?? resolveTemplate(templateContent, ctx);

    for (const channel of channels) {
      const channelKey = `${channel.type}:${channel.target}`;
      const existing = pending.current.get(channelKey);

      if (existing) {
        clearTimeout(existing.timer);
        existing.messages.push(resolved);
        existing.timer = setTimeout(() => { void flush(channelKey); }, MERGE_WINDOW_MS);
      } else {
        const logBase: Omit<NotificationDeliveryLog, 'id' | 'sent_at'> = {
          rule_id: rule.id,
          task_id: task.id,
          event_type: rule.event_type,
          triggered_by: task.creatorId,
          message_content: resolved,
          was_customized: !!customMessage,
          channel_type: channel.type,
          channel_target: channel.target,
          status: 'sent',
          error_message: null,
        };
        const timer = setTimeout(() => { void flush(channelKey); }, MERGE_WINDOW_MS);
        pending.current.set(channelKey, { timer, messages: [resolved], logBase });
      }
    }
  }, [templates, flush]);

  return { sendNotification };
}
