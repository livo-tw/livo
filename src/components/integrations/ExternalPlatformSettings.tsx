import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Slack, Clock, CheckCircle2, Unlink, Link as LinkIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuthContext } from '@/context/AuthContext';
import { useUIContext } from '@/context/UIContext';
import { useTaskContext } from '@/context/TaskContext';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { isEventEnabled } from '@/lib/featureToggles';
import { actionLogQueries, type ExternalActionLog } from '@/lib/integrationQueries';
import { loadSlackLink, setSlackLinkEnabled, type SlackLinkStatus } from '@/lib/slackLink';

const ACTION_TYPE_I18N: Record<string, string> = {
  approval_approve: 'integrations.external.actions.approve',
  approval_reject: 'integrations.external.actions.reject',
  approval_return: 'integrations.external.actions.return',
  status_change: 'integrations.external.actions.statusChange',
  comment_add: 'integrations.external.actions.commentAdd',
  task_view: 'integrations.external.actions.taskView',
  task_assign: 'integrations.external.actions.taskAssign',
  slash_command: 'integrations.external.actions.slashCommand',
};

const STATUS_BADGE_VARIANT: Record<string, { i18nKey: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  success: { i18nKey: 'integrations.external.statuses.success', variant: 'default' },
  failed: { i18nKey: 'integrations.external.statuses.failed', variant: 'destructive' },
  denied: { i18nKey: 'integrations.external.statuses.denied', variant: 'destructive' },
  expired: { i18nKey: 'integrations.external.statuses.expired', variant: 'outline' },
};

function ActionLogItem({ log, task }: { log: ExternalActionLog; task?: { taskKey: string; title: string } }) {
  const { t, i18n } = useTranslation();
  const status = STATUS_BADGE_VARIANT[log.result_status] ?? STATUS_BADGE_VARIANT.failed;
  const actionKey = ACTION_TYPE_I18N[log.action_type];
  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-muted"><Clock size={12} className="text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{actionKey ? t(actionKey) : log.action_type}</span>
          <Badge variant={status.variant} className="h-4 px-1.5 text-xs">{t(status.i18nKey)}</Badge>
        </div>
        {task && <div className="mt-0.5 truncate text-xs text-foreground"><span className="font-mono text-muted-foreground">{task.taskKey}</span> {task.title}</div>}
        {log.error_message && <div className="mt-0.5 truncate text-xs text-destructive">{log.error_message}</div>}
        <div className="mt-0.5 text-xs text-muted-foreground">{new Date(log.acted_at).toLocaleString(i18n.language)}</div>
      </div>
    </li>
  );
}

/**
 * The member's own Slack link (My settings): which Slack account LIVO uses for
 * them, and the switch to unlink it so LIVO neither acts for that account nor
 * sends it direct messages. Owners map other people's accounts in System admin.
 */
const ExternalPlatformSettings = () => {
  const { t } = useTranslation();
  const { currentMemberId } = useAuthContext();
  const { approvalsEnabled } = useUIContext();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [status, setStatus] = useState<SlackLinkStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [logs, setLogs] = useState<ExternalActionLog[]>([]);
  const [logsFailed, setLogsFailed] = useState(false);
  const [logsAttempt, setLogsAttempt] = useState(0);
  const { allTasks } = useTaskContext();

  const load = useCallback(async () => {
    setFailed(false);
    try { setStatus(await loadSlackLink()); }
    catch { setFailed(true); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  // Only the self-hosted server records actions taken from Slack.
  const showLog = status?.mode === 'binding' && !!currentMemberId;
  useEffect(() => {
    if (!showLog) return;
    let current = true;
    setLogsFailed(false);
    // A failed read says so instead of looking like "no actions yet".
    void Promise.resolve(actionLogQueries.fetchByMember(supabase, currentMemberId, 10)).then((result: { data: unknown; error: unknown }) => {
      if (!current) return;
      if (result.error) setLogsFailed(true);
      else setLogs((result.data as ExternalActionLog[] | null) ?? []);
    }, () => { if (current) setLogsFailed(true); });
    return () => { current = false; };
  }, [showLog, currentMemberId, logsAttempt]);

  const change = async (enabled: boolean) => {
    if (!enabled && !(await confirm({ title: t('settings.slackLink.confirmTitle'), description: t('settings.slackLink.confirmDesc'), destructive: true }))) return;
    setSaving(true);
    try {
      setStatus(await setSlackLinkEnabled(enabled));
      toast.success(t(enabled ? 'settings.slackLink.relinked' : 'settings.slackLink.unlinked'));
    } catch {
      toast.error(t('settings.slackLink.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const visibleLogs = logs.filter(log => isEventEnabled(log.action_type, approvalsEnabled));
  return (
    <div className="space-y-4">
      {failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
          {t('settings.slackLink.loadFailed')}
          <Button variant="outline" size="sm" onClick={() => void load()}>{t('settings.slackLink.retry')}</Button>
        </div>
      ) : !status ? (
        <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-border bg-muted"><Slack size={18} /></span>
            <div className="min-w-0 space-y-1 text-sm">
              {status.disabled ? (
                <p className="text-foreground">{t('settings.slackLink.disabled')}</p>
              ) : status.linked ? (
                <p className="flex flex-wrap items-center gap-1.5 text-foreground">
                  <CheckCircle2 size={14} className="text-green-600" />
                  {t('settings.slackLink.linked', { name: status.linked.displayName || 'Slack' })}
                  {status.linked.verifiedBy && <span className="text-xs text-muted-foreground">· {t(status.linked.verifiedBy === 'admin' ? 'settings.slackLink.byAdmin' : 'settings.slackLink.byEmail')}</span>}
                </p>
              ) : (
                <p className="text-muted-foreground">{t(status.mode === 'email' ? 'settings.slackLink.emailMode' : 'settings.slackLink.notLinkedYet')}</p>
              )}
              {status.disabled && <p className="text-xs text-muted-foreground">{t('settings.slackLink.relinkHint')}</p>}
            </div>
          </div>
          {status.disabled ? (
            <Button size="sm" className="shrink-0 gap-1.5" disabled={saving} onClick={() => void change(true)}><LinkIcon size={14} />{t('settings.slackLink.relink')}</Button>
          ) : (
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5 text-destructive hover:text-destructive" disabled={saving} onClick={() => void change(false)}><Unlink size={14} />{t('settings.slackLink.unlink')}</Button>
          )}
        </div>
      )}
      {showLog && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold text-muted-foreground">{t('settings.slackLink.recentActions')}</h4>
          {logsFailed ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-xs text-destructive">
              {t('settings.slackLink.actionsLoadFailed')}
              <Button variant="outline" size="sm" onClick={() => setLogsAttempt(n => n + 1)}>{t('settings.slackLink.retry')}</Button>
            </div>
          ) : visibleLogs.length ? (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">{visibleLogs.map(log => <ActionLogItem key={log.id} log={log} task={log.target_task_id ? allTasks.find(task => task.id === log.target_task_id) : undefined} />)}</ul>
          ) : (
            <p className="text-xs text-muted-foreground">{t('settings.slackLink.noActions')}</p>
          )}
        </div>
      )}
      {ConfirmDialog}
    </div>
  );
};

export default ExternalPlatformSettings;
