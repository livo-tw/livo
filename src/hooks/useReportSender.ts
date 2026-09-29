import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { logQueries, type ReportSendTarget, type ReportSendLog, type SendStatus } from '@/lib/reportSendQueries';
import { sendSlackReportAsync } from '@/lib/slackNotify';

export interface SendTargetState {
  target: ReportSendTarget;
  logId: string | null;
  status: SendStatus;
  error: string | null;
}

function getChannelLabel(target: ReportSendTarget): string {
  const cfg = target.channel_config as Record<string, unknown>;
  switch (target.channel_type) {
    case 'slack': return String(cfg.channel_name ?? cfg.channel_id ?? 'Slack');
    case 'email': return Array.isArray(cfg.recipients) ? (cfg.recipients as string[]).join(', ') : 'Email';
    case 'line': return 'LINE Notify';
    case 'webhook': return String(cfg.url ?? 'Webhook');
    default: return target.channel_type;
  }
}

import i18n from '@/i18n';

function getReportTypeLabel(type: string): string {
  const map: Record<string, string> = { daily: 'report.daily', weekly: 'report.weekly', monthly: 'report.monthly' };
  return map[type] ? i18n.t(map[type]) : type;
}

async function dispatchToSlack(
  target: ReportSendTarget,
  content: string,
  reportTitle: string,
  actorName: string,
): Promise<void> {
  const cfg = target.channel_config as { channel_id?: string; channel_name?: string };
  const preview = content.length > 500 ? content.slice(0, 497) + '...' : content;
  await sendSlackReportAsync(reportTitle, preview, actorName, cfg.channel_id);
}

export function useReportSender(sentBy: string) {
  const [states, setStates] = useState<SendTargetState[]>([]);
  const [sending, setSending] = useState(false);

  const updateState = useCallback((targetId: string, patch: Partial<SendTargetState>) => {
    setStates(prev => prev.map(s => s.target.id === targetId ? { ...s, ...patch } : s));
  }, []);

  const sendReport = useCallback(async (
    content: string,
    reportType: string,
    targets: ReportSendTarget[],
  ) => {
    if (targets.length === 0) return;
    setSending(true);

    // Initialize states
    const initial: SendTargetState[] = targets.map(t => ({
      target: t,
      logId: null,
      status: 'pending',
      error: null,
    }));
    setStates(initial);

    const contentPreview = content.slice(0, 200);
    const reportTitle = `${getReportTypeLabel(reportType)} - ${new Date().toLocaleDateString()}`;

    // Create log entries + dispatch all in parallel
    await Promise.all(targets.map(async target => {
      const channelTarget = getChannelLabel(target);

      // Mark sending
      updateState(target.id, { status: 'sending' });

      // Create log record
      const { data: logData } = await logQueries.create(supabase, {
        report_type: reportType,
        target_id: target.id,
        channel_type: target.channel_type,
        channel_target: channelTarget,
        format: target.format,
        content_preview: contentPreview,
        status: 'sending',
        error_message: null,
        retry_count: 0,
        sent_by: sentBy,
        completed_at: null,
      });
      const logId = (logData as ReportSendLog | null)?.id ?? null;
      updateState(target.id, { logId });

      try {
        if (target.channel_type === 'slack') {
          await dispatchToSlack(target, content, reportTitle, sentBy);
          updateState(target.id, { status: 'sent' });
          if (logId) await logQueries.updateStatus(supabase, logId, 'sent');
        } else {
          // email / line / webhook: not yet implemented — skip with friendly message
          updateState(target.id, { status: 'skipped', error: i18n.t('report.channelComingSoon') });
          if (logId) await logQueries.updateStatus(supabase, logId, 'failed', 'Channel not yet supported, skipped');
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : i18n.t('report.sendFailed');
        updateState(target.id, { status: 'failed', error: msg });
        if (logId) await logQueries.updateStatus(supabase, logId, 'failed', msg);
      }
    }));

    setSending(false);
  }, [sentBy, updateState]);

  const retryFailed = useCallback(async (content: string, reportType: string) => {
    const failed = states.filter(s => s.status === 'failed');
    if (failed.length === 0) return;
    await sendReport(content, reportType, failed.map(s => s.target));
  }, [states, sendReport]);

  const reset = useCallback(() => {
    setStates([]);
    setSending(false);
  }, []);

  const summary = {
    total: states.length,
    sent: states.filter(s => s.status === 'sent').length,
    failed: states.filter(s => s.status === 'failed').length,
    skipped: states.filter(s => s.status === 'skipped').length,
    pending: states.filter(s => s.status === 'pending' || s.status === 'sending').length,
  };

  return { states, sending, summary, sendReport, retryFailed, reset };
}
